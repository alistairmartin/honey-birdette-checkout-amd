// Cross-store theme template copying.
//
// Backs the "Template copier" admin page (app/routes/app.template-copier.jsx).
// The page runs on whichever store the app is embedded in (the source); the
// destination stores are the *other* stores this app is installed on. We reach
// them with `unauthenticated.admin(shop)`, which loads that shop's offline
// session from the Session table - the same trick the Kibo sweep uses.
//
// Copying is read-then-write: pull the file bodies out of the source theme with
// the `theme.files` query, push them into the destination theme with
// `themeFilesUpsert`. There is no cross-shop server-side copy mutation
// (`themeFilesCopy` is same-shop only), so the bodies round-trip through us.
//
// Scope: templates/* only. A JSON template names sections by `type`, and those
// section .liquid files are NOT copied - overwriting shared section code would
// change every other template that renders it. Instead `preflightMissingSections`
// reports which section types the destination theme is missing, so you can see
// before copying whether the template will render.

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { adminGraphql } from "./adminGraphql.server";

// themeFilesUpsert takes at most 50 files per call.
const UPSERT_BATCH_SIZE = 25;

// The `files` connection caps out at 2500 nodes; no theme has that many templates.
const FILE_PAGE_SIZE = 250;

// These stores keep a long tail of dated campaign themes (100+), so this pages
// rather than taking the first N.
const THEMES_QUERY = `#graphql
  query CopierThemes($after: String) {
    themes(first: 50, after: $after) {
      nodes {
        id
        name
        role
        processing
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const FILE_LIST_QUERY = `#graphql
  query CopierFileList($themeId: ID!, $patterns: [String!]!, $after: String) {
    theme(id: $themeId) {
      id
      name
      role
      files(filenames: $patterns, first: ${FILE_PAGE_SIZE}, after: $after) {
        nodes {
          filename
          size
          checksumMd5
          updatedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const FILE_BODY_QUERY = `#graphql
  query CopierFileBodies($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      files(filenames: $filenames, first: ${FILE_PAGE_SIZE}) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText {
              content
            }
            ... on OnlineStoreThemeFileBodyBase64 {
              contentBase64
            }
            ... on OnlineStoreThemeFileBodyUrl {
              url
            }
          }
        }
      }
    }
  }
`;

const UPSERT_MUTATION = `#graphql
  mutation CopierUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles {
        filename
      }
      userErrors {
        filename
        field
        message
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const SHOP_INFO_QUERY = `#graphql
  query CopierShopInfo {
    shop {
      name
      billingAddress {
        countryCodeV2
      }
    }
  }
`;

// An ISO country code to its flag emoji: "AU" -> two regional-indicator symbols.
// Derived from the store's own billing country rather than a hardcoded
// domain-to-region map, so a new regional store gets the right flag with no code
// change. Returns "" for anything that isn't a 2-letter code.
export function countryFlag(countryCode) {
  if (typeof countryCode !== "string" || !/^[A-Za-z]{2}$/.test(countryCode)) {
    return "";
  }
  return String.fromCodePoint(
    ...countryCode
      .toUpperCase()
      .split("")
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

// The merchant-facing name, country and flag for one shop.
export async function getShopInfo(admin, shop) {
  const body = await adminGraphql(admin, SHOP_INFO_QUERY);
  const countryCode = body.data?.shop?.billingAddress?.countryCodeV2 ?? null;
  return {
    shop,
    name: body.data?.shop?.name || shop,
    countryCode,
    flag: countryFlag(countryCode),
    reachable: true,
  };
}

// Every shop with an offline session - i.e. every store the app is installed on.
// Excludes `currentShop` (that's the source, it's never a destination).
export async function listDestinationShops(currentShop) {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false, shop: { not: currentShop } },
    select: { shop: true },
    distinct: ["shop"],
    orderBy: { shop: "asc" },
  });

  const shops = sessions.map((s) => s.shop);

  // Fetch the store name and country so the picker reads "Honey Birdette US 🇺🇸"
  // rather than "hb-us-prod.myshopify.com". A store whose token has gone stale
  // still shows up - with its domain as the label and `reachable: false` - so
  // the page can tell you it needs a reinstall instead of silently hiding it.
  return Promise.all(
    shops.map(async (shop) => {
      try {
        const { admin } = await unauthenticated.admin(shop);
        return await getShopInfo(admin, shop);
      } catch (err) {
        return {
          shop,
          name: shop,
          countryCode: null,
          flag: "",
          reachable: false,
          error: err?.message ?? String(err),
        };
      }
    }),
  );
}

// An admin client for any installed shop. `currentShop` reuses the embedded
// session; anything else is loaded from the Session table.
async function adminFor(shop) {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

// ---------------------------------------------------------------------------
// Themes and files
// ---------------------------------------------------------------------------

// Most-recently-edited theme first. These stores carry ~100 themes, most of them
// dated campaign snapshots, so the one you want is nearly always the one that was
// touched last; the live theme is labelled rather than pinned to the top.
export async function listThemes(admin) {
  const nodes = [];
  let after = null;

  do {
    const body = await adminGraphql(admin, THEMES_QUERY, { after });
    const connection = body.data?.themes;
    if (!connection) break;
    nodes.push(...(connection.nodes ?? []));
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return nodes.sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  );
}

export async function listThemesForShop(shop) {
  return listThemes(await adminFor(shop));
}

// All template files in a theme: templates/*.json, templates/*.liquid, and the
// customer templates under templates/customers/.
export async function listTemplateFiles(admin, themeId) {
  const files = [];
  let after = null;

  do {
    const body = await adminGraphql(admin, FILE_LIST_QUERY, {
      themeId,
      patterns: ["templates/*"],
      after,
    });
    const connection = body.data?.theme?.files;
    if (!connection) break;
    files.push(...(connection.nodes ?? []));
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return files.sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function listTemplateFilesForShop(shop, themeId) {
  return listTemplateFiles(await adminFor(shop), themeId);
}

// The body of a theme file arrives one of three ways. Large files come back as a
// URL rather than inline text, so that case has to be fetched, not just read.
async function resolveBody(node) {
  const body = node.body ?? {};
  if (typeof body.content === "string") return body.content;
  if (typeof body.contentBase64 === "string") {
    return Buffer.from(body.contentBase64, "base64").toString("utf8");
  }
  if (typeof body.url === "string") {
    const res = await fetch(body.url);
    if (!res.ok) {
      throw new Error(
        `Couldn't download ${node.filename} (HTTP ${res.status})`,
      );
    }
    return res.text();
  }
  throw new Error(`No readable body for ${node.filename}`);
}

// Read the given filenames out of a theme. Returns [{ filename, content }].
export async function readFiles(admin, themeId, filenames) {
  const out = [];

  for (let i = 0; i < filenames.length; i += 50) {
    const chunk = filenames.slice(i, i + 50);
    const body = await adminGraphql(admin, FILE_BODY_QUERY, {
      themeId,
      filenames: chunk,
    });
    const nodes = body.data?.theme?.files?.nodes ?? [];

    for (const name of chunk) {
      const node = nodes.find((n) => n.filename === name);
      if (!node) throw new Error(`${name} not found in the source theme`);
      out.push({ filename: name, content: await resolveBody(node) });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

// Pull the distinct section `type`s out of a JSON template. Both the flat
// `sections` map and the nested `blocks` of each section can name a type; only
// section types resolve to a sections/<type>.liquid file, so blocks are ignored.
export function sectionTypesIn(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return []; // .liquid template, or malformed JSON - nothing to check.
  }

  const types = new Set();
  for (const section of Object.values(parsed?.sections ?? {})) {
    if (section?.type) types.add(section.type);
  }
  return [...types];
}

// Which sections do the chosen templates need that the destination theme doesn't
// have? A missing section makes the page render blank where that section should
// be, so this is the check worth doing before writing anything.
export async function preflightMissingSections(targetAdmin, targetThemeId, files) {
  const needed = new Set();
  for (const file of files) {
    for (const type of sectionTypesIn(file.content)) needed.add(type);
  }
  if (needed.size === 0) return [];

  const present = new Set();
  const wanted = [...needed];

  for (let i = 0; i < wanted.length; i += 50) {
    const chunk = wanted.slice(i, i + 50);
    const body = await adminGraphql(targetAdmin, FILE_LIST_QUERY, {
      themeId: targetThemeId,
      patterns: chunk.flatMap((t) => [
        `sections/${t}.liquid`,
        // Theme blocks / section groups can also satisfy a type reference.
        `blocks/${t}.liquid`,
      ]),
      after: null,
    });
    for (const node of body.data?.theme?.files?.nodes ?? []) {
      const match = node.filename.match(/^(?:sections|blocks)\/(.+)\.liquid$/);
      if (match) present.add(match[1]);
    }
  }

  return wanted.filter((t) => !present.has(t)).sort();
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

// Copy `filenames` from the source shop/theme into one destination shop/theme.
// Always resolves - a failure is reported in the returned record, not thrown -
// so one dead store can't abort a copy to the other three.
export async function copyToTarget({
  sourceShop,
  sourceTheme,
  sourceFiles, // [{ filename, content }], already read once and reused per target
  targetShop,
  targetThemeId,
  copiedBy,
}) {
  const base = {
    sourceShop,
    sourceThemeId: sourceTheme.id,
    sourceThemeName: sourceTheme.name,
    targetShop,
    targetThemeId,
    fileCount: sourceFiles.length,
  };

  let targetThemeName = targetThemeId;
  let targetThemeRole = "UNKNOWN";

  try {
    const targetAdmin = await adminFor(targetShop);

    const themes = await listThemes(targetAdmin);
    const targetTheme = themes.find((t) => t.id === targetThemeId);
    if (!targetTheme) {
      throw new Error("That theme no longer exists on the destination store");
    }
    targetThemeName = targetTheme.name;
    targetThemeRole = targetTheme.role;
    if (targetTheme.processing) {
      throw new Error(
        "The destination theme is still processing - wait for it to finish, then retry",
      );
    }

    const results = new Map(
      sourceFiles.map((f) => [f.filename, { filename: f.filename, status: "PENDING", error: null }]),
    );

    for (let i = 0; i < sourceFiles.length; i += UPSERT_BATCH_SIZE) {
      const batch = sourceFiles.slice(i, i + UPSERT_BATCH_SIZE);
      const body = await adminGraphql(targetAdmin, UPSERT_MUTATION, {
        themeId: targetThemeId,
        files: batch.map((f) => ({
          filename: f.filename,
          body: { type: "TEXT", value: f.content },
        })),
      });

      const payload = body.data?.themeFilesUpsert;
      for (const err of payload?.userErrors ?? []) {
        // A userError without a filename applies to the whole batch.
        const targets = err.filename
          ? [err.filename]
          : batch.map((f) => f.filename);
        for (const name of targets) {
          const record = results.get(name);
          if (record) {
            record.status = "FAILED";
            record.error = err.message;
          }
        }
      }
      for (const upserted of payload?.upsertedThemeFiles ?? []) {
        const record = results.get(upserted.filename);
        if (record && record.status !== "FAILED") record.status = "SUCCESS";
      }
    }

    // Anything Shopify neither confirmed nor complained about didn't land.
    for (const record of results.values()) {
      if (record.status === "PENDING") {
        record.status = "FAILED";
        record.error = "The destination store didn't confirm this file was written";
      }
    }

    const files = [...results.values()];
    const successCount = files.filter((f) => f.status === "SUCCESS").length;
    const status =
      successCount === files.length
        ? "SUCCESS"
        : successCount === 0
          ? "FAILED"
          : "PARTIAL";

    const record = {
      ...base,
      targetThemeName,
      targetThemeRole,
      successCount,
      status,
      files,
      error: null,
    };
    await logCopy(record, copiedBy);
    return record;
  } catch (err) {
    const message = err?.message ?? String(err);
    const record = {
      ...base,
      targetThemeName,
      targetThemeRole,
      successCount: 0,
      status: "FAILED",
      files: sourceFiles.map((f) => ({
        filename: f.filename,
        status: "FAILED",
        error: message,
      })),
      error: message,
    };
    await logCopy(record, copiedBy);
    return record;
  }
}

async function logCopy(record, copiedBy) {
  try {
    await prisma.themeCopyLog.create({
      data: {
        sourceShop: record.sourceShop,
        sourceThemeId: record.sourceThemeId,
        sourceThemeName: record.sourceThemeName,
        targetShop: record.targetShop,
        targetThemeId: record.targetThemeId,
        targetThemeName: record.targetThemeName,
        targetThemeRole: record.targetThemeRole,
        fileCount: record.fileCount,
        successCount: record.successCount,
        status: record.status,
        filesJson: JSON.stringify(record.files),
        error: record.error,
        copiedBy: copiedBy ?? null,
      },
    });
  } catch {
    // A copy that worked shouldn't look like it failed because the audit write
    // did. The result still comes back to the page either way.
  }
}

export async function recentCopies(sourceShop, limit = 20) {
  const rows = await prisma.themeCopyLog.findMany({
    where: { sourceShop },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((row) => ({
    ...row,
    files: JSON.parse(row.filesJson),
    createdAt: row.createdAt.toISOString(),
  }));
}
