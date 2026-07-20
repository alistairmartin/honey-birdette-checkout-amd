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
import { adminGraphql, sleep } from "./adminGraphql.server";

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
      currencyCode
      billingAddress {
        countryCodeV2
      }
    }
  }
`;

// The store's selling currency identifies its region better than its billing
// address does: the EU store is legally registered in GB, so its billing country
// says GB while the store it actually is sells in EUR. Currency wins, and the
// billing country is the fallback for anything not listed here.
const CURRENCY_REGION = {
  AUD: "AU",
  EUR: "EU",
  GBP: "GB",
  USD: "US",
  NZD: "NZ",
  CAD: "CA",
};

// A 2-letter region code to its flag emoji: "AU" -> two regional-indicator
// symbols. "EU" is a valid pair and renders as 🇪🇺. Returns "" for anything that
// isn't a 2-letter code.
export function countryFlag(code) {
  if (typeof code !== "string" || !/^[A-Za-z]{2}$/.test(code)) return "";
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

// The merchant-facing name, region and flag for one shop.
export async function getShopInfo(admin, shop) {
  const body = await adminGraphql(admin, SHOP_INFO_QUERY);
  const currency = body.data?.shop?.currencyCode ?? null;
  const country = body.data?.shop?.billingAddress?.countryCodeV2 ?? null;
  const region = CURRENCY_REGION[currency] ?? country;

  return {
    shop,
    name: body.data?.shop?.name || shop,
    region,
    flag: countryFlag(region),
    reachable: true,
  };
}

// Who ran this copy. The acting staff member's user ID comes from the session
// token's `sub` claim (see the api.template-copy route) - that's the one piece
// of "who" Shopify always gives an embedded app, even on an offline session.
// The ID alone isn't much use for "go ask them", so we turn it into a name and
// email via the staffMember query. That query needs no extra scope for most
// stores, but if it's ever refused we fall back to a labelled ID rather than
// losing the attribution - the whole point is to know who to ask after a bad
// copy, and an ID still identifies them in the admin.
export async function resolveActor(admin, userId) {
  if (!userId) return null;

  try {
    const body = await adminGraphql(
      admin,
      `#graphql
        query CopierActor($id: ID!) {
          staffMember(id: $id) {
            name
            email
            isShopOwner
          }
        }
      `,
      { id: `gid://shopify/StaffMember/${userId}` },
    );

    const staff = body.data?.staffMember;
    if (staff?.name || staff?.email) {
      const owner = staff.isShopOwner ? " (store owner)" : "";
      if (staff.name && staff.email) return `${staff.name} <${staff.email}>${owner}`;
      return `${staff.name || staff.email}${owner}`;
    }
  } catch {
    // Fall through to the ID.
  }

  return `Staff user ${userId}`;
}

// The order the regions are always listed in, everywhere. Fixed rather than
// alphabetical or install-order so the stores sit in the same place on every
// page - you learn the positions instead of re-reading the labels. `region`
// comes from getShopInfo (currency-derived), so the UK store is GB.
const REGION_ORDER = ["AU", "GB", "EU", "US"];

export function sortStoresByRegion(stores) {
  return [...stores].sort((a, b) => {
    const ai = REGION_ORDER.indexOf(a.region ?? "");
    const bi = REGION_ORDER.indexOf(b.region ?? "");
    // Anything outside the known set (a new market, or a store we couldn't
    // reach to identify) sorts last, alphabetically.
    if (ai === -1 && bi === -1) {
      return (a.name || a.shop).localeCompare(b.name || b.shop);
    }
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
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
          region: null,
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

// Like readFiles, but a filename that isn't in the theme is simply absent from
// the result rather than an error - on the destination side "this template
// doesn't exist yet" is a normal answer, and means the copy creates it.
// Returns a Map of filename -> content.
export async function readFilesIfPresent(admin, themeId, filenames) {
  const out = new Map();

  for (let i = 0; i < filenames.length; i += 50) {
    const chunk = filenames.slice(i, i + 50);
    const body = await adminGraphql(admin, FILE_BODY_QUERY, {
      themeId,
      filenames: chunk,
    });
    for (const node of body.data?.theme?.files?.nodes ?? []) {
      out.set(node.filename, await resolveBody(node));
    }
  }

  return out;
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
  return templateDependencies(content).sectionTypes;
}

// What a JSON template needs to exist in the theme alongside it.
//
// A section's `type` resolves to sections/<type>.liquid. A *theme block's*
// `type` resolves to blocks/<type>.liquid, and blocks nest arbitrarily deep -
// which is exactly what bit us: a template referencing an AI-generated block was
// accepted by our old check (it only read the top-level sections map) and then
// rejected outright by Shopify with "The given theme block type must be defined
// in the theme blocks folder".
//
// Note a nested `type` can also be a *local* block declared in the section's own
// schema (e.g. "text"), which is not a file. We don't try to tell them apart
// here - the caller resolves that by checking which types actually exist as
// files in the source theme.
export function templateDependencies(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { sectionTypes: [], blockTypes: [] }; // .liquid template, or not JSON.
  }

  const sectionTypes = new Set();
  const blockTypes = new Set();

  const walkBlocks = (blocks, depth = 0) => {
    // Templates are authored data; guard against a pathological nesting depth.
    if (!blocks || depth > 20) return;
    for (const block of Object.values(blocks)) {
      if (block?.type) blockTypes.add(block.type);
      if (block?.blocks) walkBlocks(block.blocks, depth + 1);
    }
  };

  for (const section of Object.values(parsed?.sections ?? {})) {
    if (section?.type) sectionTypes.add(section.type);
    walkBlocks(section?.blocks);
  }

  return { sectionTypes: [...sectionTypes], blockTypes: [...blockTypes] };
}

// Which of these exact filenames exist in a theme.
async function themeFilesPresent(admin, themeId, filenames) {
  const present = new Set();

  for (let i = 0; i < filenames.length; i += 50) {
    const chunk = filenames.slice(i, i + 50);
    const body = await adminGraphql(admin, FILE_LIST_QUERY, {
      themeId,
      patterns: chunk,
      after: null,
    });
    for (const node of body.data?.theme?.files?.nodes ?? []) {
      present.add(node.filename);
    }
  }

  return present;
}

// Work out which section/block files the chosen templates depend on, and which
// of those the destination theme is missing.
//
// A type only counts as a real dependency if it exists as a file in the SOURCE
// theme - that's what separates a theme block (a file we can copy) from a local
// block declared inside a section's schema (not a file, nothing to copy).
export async function planDependencies({
  sourceAdmin,
  sourceThemeId,
  targetAdmin,
  targetThemeId,
  files,
}) {
  const sectionTypes = new Set();
  const blockTypes = new Set();
  for (const file of files) {
    const deps = templateDependencies(file.content);
    deps.sectionTypes.forEach((t) => sectionTypes.add(t));
    deps.blockTypes.forEach((t) => blockTypes.add(t));
  }

  const candidates = [
    ...[...sectionTypes].map((t) => `sections/${t}.liquid`),
    ...[...blockTypes].map((t) => `blocks/${t}.liquid`),
  ];
  if (candidates.length === 0) {
    return { toCopy: [], alreadyPresent: [], unresolved: [] };
  }

  const [onSource, onTarget] = await Promise.all([
    themeFilesPresent(sourceAdmin, sourceThemeId, candidates),
    themeFilesPresent(targetAdmin, targetThemeId, candidates),
  ]);

  return {
    // Real files the destination hasn't got - these are what break the upsert.
    toCopy: candidates.filter((f) => onSource.has(f) && !onTarget.has(f)),
    alreadyPresent: candidates.filter((f) => onTarget.has(f)),
    // Referenced by the template but not a file in either theme. Usually a local
    // block type (fine); occasionally a genuinely dangling reference.
    unresolved: candidates.filter((f) => !onSource.has(f) && !onTarget.has(f)),
  };
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
// Diff
// ---------------------------------------------------------------------------

// A JSON template is a map of sections, each with a `type`, a `settings` object
// and optional `blocks`, plus an `order` array. Diffing it structurally (rather
// than as text) is what lets the confirm screen say "4 sections change, 12
// setting values differ" instead of "the file is different".

const stable = (value) => JSON.stringify(value ?? null);

function diffSettings(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => stable(before[k]) !== stable(after[k])).sort();
}

function diffJsonTemplate(before, after) {
  const beforeSections = before?.sections ?? {};
  const afterSections = after?.sections ?? {};
  const ids = new Set([
    ...Object.keys(beforeSections),
    ...Object.keys(afterSections),
  ]);

  const added = [];
  const removed = [];
  const changed = [];
  let settingsChangedCount = 0;

  for (const id of ids) {
    const b = beforeSections[id];
    const a = afterSections[id];

    if (!b && a) {
      added.push({ id, type: a.type ?? "unknown" });
      continue;
    }
    if (b && !a) {
      removed.push({ id, type: b.type ?? "unknown" });
      continue;
    }
    if (stable(b) === stable(a)) continue;

    const settings = diffSettings(b.settings, a.settings);
    const beforeBlocks = b.blocks ?? {};
    const afterBlocks = a.blocks ?? {};
    const blockIds = new Set([
      ...Object.keys(beforeBlocks),
      ...Object.keys(afterBlocks),
    ]);
    const blocksChanged = [...blockIds].filter(
      (id2) => stable(beforeBlocks[id2]) !== stable(afterBlocks[id2]),
    ).length;

    settingsChangedCount += settings.length;
    changed.push({
      id,
      // Type changing under the same section id is worth calling out on its own:
      // it means the destination renders a different section entirely.
      type: a.type ?? "unknown",
      typeChanged: b.type !== a.type ? { from: b.type, to: a.type } : null,
      settings,
      blocksChanged,
    });
  }

  const orderChanged = stable(before?.order) !== stable(after?.order);

  return {
    kind: "json",
    added,
    removed,
    changed,
    settingsChangedCount,
    orderChanged,
  };
}

// .liquid templates (and any JSON we can't parse) get a line count instead.
// Multiset comparison, not a real LCS - it answers "how much moves", which is
// all the summary claims.
function diffText(before, after) {
  const count = (lines) => {
    const map = new Map();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const b = count(before.split("\n"));
  const a = count(after.split("\n"));

  let addedLines = 0;
  let removedLines = 0;
  for (const [line, n] of a) addedLines += Math.max(0, n - (b.get(line) ?? 0));
  for (const [line, n] of b) removedLines += Math.max(0, n - (a.get(line) ?? 0));

  return { kind: "text", addedLines, removedLines };
}

// One plain-English line per file: what this copy does to the destination.
function summarise(diff) {
  if (diff.status === "NEW") return "New file, will be created";
  if (diff.status === "IDENTICAL") return "Identical, no change";

  const parts = [];
  if (diff.kind === "json") {
    const n = (count, word) =>
      `${count} ${word}${count === 1 ? "" : "s"}`;
    if (diff.changed.length) parts.push(`${n(diff.changed.length, "section")} edited`);
    if (diff.settingsChangedCount)
      parts.push(`${n(diff.settingsChangedCount, "setting value")} changed`);
    if (diff.added.length) parts.push(`${n(diff.added.length, "section")} added`);
    if (diff.removed.length)
      parts.push(`${n(diff.removed.length, "section")} removed`);
    if (diff.orderChanged) parts.push("section order changed");
  } else {
    if (diff.addedLines) parts.push(`${diff.addedLines} lines added`);
    if (diff.removedLines) parts.push(`${diff.removedLines} lines removed`);
  }

  return parts.length ? parts.join(", ") : "Changed";
}

// Compare one source file against the destination theme's current version.
export function diffFile(filename, sourceContent, targetContent) {
  if (targetContent === undefined) {
    return { filename, status: "NEW", summary: summarise({ status: "NEW" }) };
  }
  if (targetContent === sourceContent) {
    return {
      filename,
      status: "IDENTICAL",
      summary: summarise({ status: "IDENTICAL" }),
    };
  }

  let diff;
  try {
    // `before` is what the destination has now, `after` is what it will have.
    diff = diffJsonTemplate(JSON.parse(targetContent), JSON.parse(sourceContent));
  } catch {
    diff = diffText(targetContent, sourceContent);
  }

  return {
    filename,
    status: "CHANGED",
    summary: summarise({ ...diff, status: "CHANGED" }),
    ...diff,
  };
}

// ---------------------------------------------------------------------------
// Content files (images and videos)
// ---------------------------------------------------------------------------
//
// A JSON template doesn't embed its media - it references it by filename, as
// `shopify://shop_images/hero.jpg` or `shopify://shop_videos/clip.mp4`, which
// Shopify resolves against that store's Content > Files. Copy the template alone
// and every image and video on the page breaks, because the destination store has
// never heard of hero.jpg. So the referenced media is copied too, under the same
// filename, which is what the reference resolves on.
//
// Images and videos take different routes into a store, and this is not a choice:
// fileCreate's originalSource accepts "an external URL (for images only) or a
// staged upload URL". So an image is ingested straight from the source store's
// CDN URL and never passes through us, while a video has to be downloaded here
// and re-uploaded to a staged target. Hence the size cap below - a 2 GB video
// would take the app's memory with it.

const MEDIA_REF = /shopify:\/\/(shop_images|shop_videos)\/([^"'\\)\s]+)/g;

// Videos are buffered in memory to move them, so refuse the ones that would hurt.
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

const FILE_LOOKUP_QUERY = `#graphql
  query CopierFileLookup($query: String!) {
    files(first: 10, query: $query) {
      nodes {
        id
        alt
        fileStatus
        ... on MediaImage {
          mimeType
          image {
            url
          }
        }
        ... on Video {
          filename
          originalSource {
            url
            mimeType
            fileSize
          }
        }
      }
    }
  }
`;

// Read back what a created file actually ended up being called. Shopify makes
// filenames unique per store: if "hero.jpg" is already taken and it can't
// replace it, the upload lands as "hero_<uuid>.jpg". The templates reference the
// file BY NAME, so a silent rename would leave every reference to it broken.
// Files are processed asynchronously, so the real name only appears once the
// file reaches READY.
const FILE_STATUS_QUERY = `#graphql
  query CopierFileStatus($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on MediaImage {
        id
        fileStatus
        image {
          url
        }
      }
      ... on Video {
        id
        fileStatus
        filename
      }
    }
  }
`;

const FILE_CREATE_MUTATION = `#graphql
  mutation CopierFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const STAGED_UPLOADS_MUTATION = `#graphql
  mutation CopierStagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// The filename Shopify actually gave a file, once it's finished processing.
// Returns a Map of file GID -> { filename, ready }.
async function resolveActualFilenames(admin, ids) {
  const out = new Map();
  if (ids.length === 0) return out;

  // Files usually go READY within a second or two; give it a few tries rather
  // than blocking the copy indefinitely.
  const MAX_ATTEMPTS = 6;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const pending = ids.filter((id) => !out.get(id)?.ready);
    if (pending.length === 0) break;
    if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 4000));

    const body = await adminGraphql(admin, FILE_STATUS_QUERY, { ids: pending });

    for (const node of body.data?.nodes ?? []) {
      if (!node?.id) continue;
      const ready = node.fileStatus === "READY";
      let filename = node.filename ?? null;

      if (!filename && node.image?.url) {
        try {
          filename = decodeURIComponent(
            new URL(node.image.url).pathname.split("/").pop() ?? "",
          );
        } catch {
          filename = null;
        }
      }

      out.set(node.id, { filename, ready });
    }
  }

  return out;
}

// Point the templates at the filenames the destination store actually used.
// Returns a NEW array - `sourceFiles` is shared across every destination, so it
// must never be mutated here; two stores can rename the same image differently.
export function applyMediaRenames(files, renames) {
  if (!renames || renames.size === 0) return files;

  return files.map((file) => ({
    ...file,
    content: file.content.replace(MEDIA_REF, (match, scheme, raw) => {
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // Keep the raw token; a malformed escape still identifies the file.
      }
      const kind = scheme === "shop_videos" ? "VIDEO" : "IMAGE";
      const renamed = renames.get(`${kind}:${decoded}`);
      if (!renamed) return match;
      // Re-encode the way Shopify writes these references (spaces as %20),
      // keeping any path separators intact.
      const encoded = encodeURIComponent(renamed).replace(/%2F/g, "/");
      return `shopify://${scheme}/${encoded}`;
    }),
  }));
}

// Every `shopify://shop_images/...` and `shopify://shop_videos/...` reference in
// these templates, as [{ kind: "IMAGE" | "VIDEO", filename }].
export function mediaRefsIn(files) {
  const found = new Map();

  for (const file of files) {
    for (const [, scheme, raw] of file.content.matchAll(MEDIA_REF)) {
      // The reference is URL-encoded in the JSON (spaces as %20, etc).
      let filename = raw;
      try {
        filename = decodeURIComponent(raw);
      } catch {
        // Leave it as-is; a malformed escape is still a usable filename.
      }
      const kind = scheme === "shop_videos" ? "VIDEO" : "IMAGE";
      found.set(`${kind}:${filename}`, { kind, filename });
    }
  }

  return [...found.values()].sort((a, b) =>
    a.filename.localeCompare(b.filename),
  );
}

// Look one filename up in a store's Files. Shopify's `files` query matches
// loosely, so the result is re-checked against the exact filename - "hero.jpg"
// must not match "hero-2.jpg".
async function findMedia(admin, { kind, filename }) {
  const body = await adminGraphql(admin, FILE_LOOKUP_QUERY, {
    query: `filename:'${filename.replace(/'/g, "")}'`,
  });

  for (const node of body.data?.files?.nodes ?? []) {
    if (kind === "VIDEO") {
      if (node.filename !== filename) continue;
      return {
        kind,
        id: node.id,
        alt: node.alt ?? null,
        // originalSource is null until Shopify finishes processing the video.
        url: node.originalSource?.url ?? null,
        mimeType: node.originalSource?.mimeType ?? "video/mp4",
        fileSize: Number(node.originalSource?.fileSize ?? 0),
        ready: node.fileStatus === "READY",
      };
    }

    const url = node.image?.url;
    if (!url) continue;
    const actual = decodeURIComponent(
      new URL(url).pathname.split("/").pop() ?? "",
    );
    if (actual !== filename) continue;
    return {
      kind,
      id: node.id,
      alt: node.alt ?? null,
      url,
      mimeType: node.mimeType,
      ready: true,
    };
  }

  return null;
}

// Which of this media does the destination store already have?
export async function mediaStatusOnTarget(admin, refs) {
  const present = [];
  const missing = [];

  for (const ref of refs) {
    const found = await findMedia(admin, ref);
    (found ? present : missing).push(ref);
  }

  return { present, missing };
}

// Move one video: download it from the source store's CDN, push the bytes to a
// staged upload target on the destination, and hand fileCreate the resource URL.
async function stageVideo(targetAdmin, { filename, source }) {
  const res = await fetch(source.url);
  if (!res.ok) {
    throw new Error(`Couldn't download the video (HTTP ${res.status})`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_VIDEO_BYTES) {
    throw new Error(
      `Video is ${(bytes.length / 1024 / 1024).toFixed(0)} MB, over the ${MAX_VIDEO_BYTES / 1024 / 1024} MB copy limit. Upload it to the destination store by hand.`,
    );
  }

  const staged = await adminGraphql(targetAdmin, STAGED_UPLOADS_MUTATION, {
    input: [
      {
        filename,
        mimeType: source.mimeType || "video/mp4",
        resource: "VIDEO",
        fileSize: String(bytes.length),
        httpMethod: "POST",
      },
    ],
  });

  const errors = staged.data?.stagedUploadsCreate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }

  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url) throw new Error("Shopify returned no upload target");

  // The signed parameters must be appended before the file itself.
  const form = new FormData();
  for (const { name, value } of target.parameters ?? []) form.append(name, value);
  form.append(
    "file",
    new Blob([bytes], { type: source.mimeType || "video/mp4" }),
    filename,
  );

  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) {
    throw new Error(`Upload to the destination store failed (HTTP ${upload.status})`);
  }

  return target.resourceUrl;
}

// Copy referenced media into the destination store's Files. Returns one record
// per file: COPIED | OVERWRITTEN | SKIPPED | FAILED.
//
// `conflictMode` decides what happens when the destination already has a file
// with that name:
//   "keep"      - leave the destination's file alone; the template uses it.
//   "duplicate" - upload the source's file under a NEW unique name and point the
//                 template at it. Nothing on the destination is overwritten, and
//                 the copied page still shows the source's images.
//   "replace"   - overwrite the destination's file. Affects every other page
//                 there that uses it, and can't be undone.
export async function copyMedia({
  sourceAdmin,
  targetAdmin,
  refs,
  conflictMode = "keep",
  onProgress = () => {},
}) {
  const results = [];
  const toCreate = [];

  let checked = 0;
  for (const ref of refs) {
    const { kind, filename } = ref;
    checked += 1;
    onProgress(
      `Checking ${kind === "VIDEO" ? "video" : "image"} ${checked}/${refs.length}: ${filename}`,
    );
    try {
      const existing = await findMedia(targetAdmin, ref);
      if (existing && conflictMode === "keep") {
        results.push({
          filename,
          kind,
          status: "SKIPPED",
          error: null,
          note: "Already on the destination store, kept as-is",
        });
        continue;
      }

      const source = await findMedia(sourceAdmin, ref);
      if (!source) {
        results.push({
          filename,
          kind,
          status: "FAILED",
          error: "Not found in the source store's Files",
        });
        continue;
      }
      if (!source.url) {
        results.push({
          filename,
          kind,
          status: "FAILED",
          error:
            "The source store is still processing this video - retry once it's ready",
        });
        continue;
      }

      // A video's bytes have to be staged one at a time; an image is just a URL.
      // Only a real collision needs resolving. With no existing file, REPLACE
      // just creates it under the exact name the templates already point at.
      const resolution =
        existing && conflictMode === "duplicate" ? "APPEND_UUID" : "REPLACE";

      if (kind === "VIDEO") {
        const resourceUrl = await stageVideo(targetAdmin, { filename, source });
        toCreate.push({
          filename,
          kind,
          source,
          originalSource: resourceUrl,
          replacing: Boolean(existing),
          resolution,
        });
      } else {
        toCreate.push({
          filename,
          kind,
          source,
          originalSource: source.url,
          replacing: Boolean(existing),
          resolution,
        });
      }
    } catch (err) {
      results.push({
        filename,
        kind,
        status: "FAILED",
        error: err?.message ?? String(err),
      });
    }
  }

  // fileCreate takes a batch; the filename is what makes the template's
  // shopify://shop_images/<name> reference resolve, so it has to be preserved.
  for (let i = 0; i < toCreate.length; i += 20) {
    const batch = toCreate.slice(i, i + 20);
    try {
      const body = await adminGraphql(targetAdmin, FILE_CREATE_MUTATION, {
        files: batch.map(({ filename, kind, source, originalSource, resolution }) => ({
          filename,
          originalSource,
          contentType: kind,
          alt: source.alt ?? "",
          duplicateResolutionMode: resolution,
        })),
      });

      const errors = body.data?.fileCreate?.userErrors ?? [];
      if (errors.length) {
        const message = errors.map((e) => e.message).join("; ");
        for (const { filename, kind } of batch) {
          results.push({ filename, kind, status: "FAILED", error: message });
        }
        continue;
      }

      // fileCreate returns the files in the order they were sent, so the Nth id
      // belongs to the Nth request. Read back what each one is actually called:
      // if the name was taken and Shopify couldn't replace it, the file landed
      // with a uniquifying suffix and the templates must follow it there.
      const created = body.data?.fileCreate?.files ?? [];
      const ids = created.map((f) => f.id).filter(Boolean);
      const actual = await resolveActualFilenames(targetAdmin, ids);

      batch.forEach(({ filename, kind, replacing, resolution }, index) => {
        const id = created[index]?.id ?? null;
        const resolved = id ? actual.get(id) : null;
        const actualFilename = resolved?.filename ?? null;
        const renamed = Boolean(actualFilename && actualFilename !== filename);

        results.push({
          filename,
          kind,
          status:
            resolution === "APPEND_UUID"
              ? "COPIED_AS_NEW"
              : replacing
                ? "OVERWRITTEN"
                : "COPIED",
          error: null,
          // Set only when the destination store gave the file a different name.
          actualFilename: renamed ? actualFilename : null,
          // Shopify hadn't finished processing in time, so we couldn't confirm
          // the name. Reported rather than assumed correct.
          unverified: !resolved?.ready,
        });
      });
    } catch (err) {
      const message = err?.message ?? String(err);
      for (const { filename, kind } of batch) {
        results.push({ filename, kind, status: "FAILED", error: message });
      }
    }
  }

  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}

// Everything the confirm screen needs about one destination: what breaks
// (missing sections), what changes (per-file diffs), and which referenced images
// and videos the destination store is missing.
export async function reviewTarget({
  targetShop,
  targetThemeId,
  sourceFiles,
  sourceAdmin,
  sourceThemeId,
}) {
  const admin = await adminFor(targetShop);
  const refs = mediaRefsIn(sourceFiles);

  const [targetContents, media, dependencies] = await Promise.all([
    readFilesIfPresent(
      admin,
      targetThemeId,
      sourceFiles.map((f) => f.filename),
    ),
    mediaStatusOnTarget(admin, refs),
    sourceAdmin && sourceThemeId
      ? planDependencies({
          sourceAdmin,
          sourceThemeId,
          targetAdmin: admin,
          targetThemeId,
          files: sourceFiles,
        })
      : Promise.resolve({ toCopy: [], alreadyPresent: [], unresolved: [] }),
  ]);

  // Media the template points at that isn't in the SOURCE store's Files. The
  // reference is already broken on the source theme, so copying won't make it
  // worse - but it's worth knowing before you copy rather than after.
  const missingOnSource = [];
  if (sourceAdmin) {
    for (const ref of refs) {
      try {
        if (!(await findMedia(sourceAdmin, ref))) missingOnSource.push(ref);
      } catch {
        // A lookup failure isn't proof it's missing; stay quiet.
      }
    }
  }

  const files = sourceFiles.map((f) =>
    diffFile(f.filename, f.content, targetContents.get(f.filename)),
  );

  return {
    // Section/block files that will be copied so the templates are accepted.
    dependenciesToCopy: dependencies.toCopy,
    // Referenced types that are files nowhere - usually local block types.
    dependenciesUnresolved: dependencies.unresolved,
    files,
    mediaReferenced: refs,
    mediaMissing: media.missing,
    mediaPresent: media.present,
    mediaMissingOnSource: missingOnSource,
    changedCount: files.filter((f) => f.status === "CHANGED").length,
    newCount: files.filter((f) => f.status === "NEW").length,
    identicalCount: files.filter((f) => f.status === "IDENTICAL").length,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

// Copy `filenames` from the source shop/theme into one destination shop/theme.
// Always resolves - a failure is reported in the returned record, not thrown -
// so one dead store can't abort a copy to the other three.
export async function copyToTarget({
  batchId,
  embeddedShop,
  sourceShop,
  sourceAdmin,
  sourceTheme,
  sourceFiles, // [{ filename, content }], already read once and reused per target
  targetShop,
  targetThemeId,
  copyMediaEnabled = true,
  // "keep" | "duplicate" | "replace" - see copyMedia.
  mediaConflictMode = "keep",
  // Section/theme-block files the templates need. On by default: without them
  // Shopify rejects the template outright, so a copy without them mostly fails.
  copyDependencies = true,
  copiedBy,
}) {
  const base = {
    batchId,
    // Who owns this copy for history/revert - the store driving the app. Falls
    // back to sourceShop when not supplied (keeps older callers working).
    embeddedShop: embeddedShop ?? sourceShop,
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

    // Snapshot what the destination has *before* we overwrite it. This is what
    // Revert restores; a file with no previous version was created by this copy,
    // so reverting deletes it. Shopify's theme timeline can do this too, but only
    // per theme, by hand, and only for someone who knows which version to pick.
    const previousContents = await readFilesIfPresent(
      targetAdmin,
      targetThemeId,
      sourceFiles.map((f) => f.filename),
    );
    const previous = sourceFiles.map((f) => ({
      filename: f.filename,
      content: previousContents.get(f.filename) ?? null,
    }));

    // Media first, templates second - and not just to avoid a window where the
    // page renders without its images. The destination store decides the final
    // filenames, and a template references media BY NAME, so the templates can
    // only be written once we know what those names turned out to be.
    const media = copyMediaEnabled
      ? await copyMedia({
          sourceAdmin,
          targetAdmin,
          refs: mediaRefsIn(sourceFiles),
          conflictMode: mediaConflictMode,
        })
      : [];

    // Anything the destination renamed (e.g. "hero.jpg" -> "hero_a1b2c3.jpg"
    // because that name was taken) is rewritten into this target's copy of the
    // templates, so the references resolve instead of rendering as broken media.
    const renames = new Map(
      media
        .filter((m) => m.actualFilename)
        .map((m) => [`${m.kind}:${m.filename}`, m.actualFilename]),
    );
    const filesToWrite = applyMediaRenames(sourceFiles, renames);

    // Section and theme-block files the templates depend on. Shopify REJECTS a
    // template that names a block type with no blocks/<type>.liquid behind it,
    // so these have to land before the templates do. Only files the destination
    // is missing are copied - existing shared code is never overwritten.
    const dependencies = [];
    if (copyDependencies) {
      const plan = await planDependencies({
        sourceAdmin,
        sourceThemeId: sourceTheme.id,
        targetAdmin,
        targetThemeId,
        files: sourceFiles,
      });

      if (plan.toCopy.length > 0) {
        const depFiles = await readFiles(
          sourceAdmin,
          sourceTheme.id,
          plan.toCopy,
        );

        for (let i = 0; i < depFiles.length; i += UPSERT_BATCH_SIZE) {
          const batch = depFiles.slice(i, i + UPSERT_BATCH_SIZE);
          const body = await adminGraphql(targetAdmin, UPSERT_MUTATION, {
            themeId: targetThemeId,
            files: batch.map((f) => ({
              filename: f.filename,
              body: { type: "TEXT", value: f.content },
            })),
          });
          const payload = body.data?.themeFilesUpsert;
          const failed = new Map();
          for (const err of payload?.userErrors ?? []) {
            const names = err.filename
              ? [err.filename]
              : batch.map((f) => f.filename);
            for (const n of names) failed.set(n, err.message);
          }
          for (const f of batch) {
            dependencies.push({
              filename: f.filename,
              status: failed.has(f.filename) ? "FAILED" : "COPIED",
              error: failed.get(f.filename) ?? null,
            });
          }
        }
      }
    }

    const results = new Map(
      sourceFiles.map((f) => [f.filename, { filename: f.filename, status: "PENDING", error: null }]),
    );

    for (let i = 0; i < filesToWrite.length; i += UPSERT_BATCH_SIZE) {
      const batch = filesToWrite.slice(i, i + UPSERT_BATCH_SIZE);
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
        // Keep the field path when Shopify gives one - "files.0.body" is the
        // difference between a bad template and a bad request.
        const field = Array.isArray(err.field) ? err.field.join(".") : err.field;
        const message = field ? `${err.message} (${field})` : err.message;
        for (const name of targets) {
          const record = results.get(name);
          if (record) {
            record.status = "FAILED";
            record.error = message;
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
      media,
      // Section/block files copied so the templates would be accepted.
      dependencies,
      // [{ kind, from, to }] - reported so it's visible that the destination
      // store renamed a file and the templates were pointed at the new name.
      mediaRenames: media
        .filter((m) => m.actualFilename)
        .map((m) => ({ kind: m.kind, from: m.filename, to: m.actualFilename })),
      previous,
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
      media: [],
      dependencies: [],
      mediaRenames: [],
      previous: [],
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
        batchId: record.batchId ?? "",
        embeddedShop: record.embeddedShop ?? record.sourceShop,
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
        imagesJson: JSON.stringify(record.media ?? []),
        previousJson: JSON.stringify(record.previous ?? []),
        error: record.error,
        copiedBy: copiedBy ?? null,
      },
    });
  } catch {
    // A copy that worked shouldn't look like it failed because the audit write
    // did. The result still comes back to the page either way.
  }
}

const hydrate = (row) => ({
  id: row.id,
  batchId: row.batchId,
  sourceShop: row.sourceShop,
  sourceThemeName: row.sourceThemeName,
  targetShop: row.targetShop,
  targetThemeId: row.targetThemeId,
  targetThemeName: row.targetThemeName,
  targetThemeRole: row.targetThemeRole,
  fileCount: row.fileCount,
  successCount: row.successCount,
  status: row.status,
  error: row.error,
  copiedBy: row.copiedBy,
  createdAt: row.createdAt.toISOString(),
  revertedAt: row.revertedAt ? row.revertedAt.toISOString() : null,
  files: JSON.parse(row.filesJson),
  media: JSON.parse(row.imagesJson ?? "[]"),
  // Whether a revert is even possible: we need the pre-copy snapshot, and it
  // only exists for copies made after that feature landed.
  revertable:
    !row.revertedAt &&
    row.status !== "FAILED" &&
    JSON.parse(row.previousJson ?? "[]").length > 0,
});

// History, grouped into batches - one batch per press of the Copy button, so
// "copied page.bridal to US, UK and EU at 15:29" reads as one event rather than
// three unrelated lines. Scoped to the store viewing the app (embeddedShop),
// whatever the copy's source was. Old rows predate embeddedShop and stored the
// viewing store in sourceShop, so match either.
export async function recentCopies(embeddedShop, limit = 60) {
  const rows = await prisma.themeCopyLog.findMany({
    where: {
      OR: [
        { embeddedShop },
        { embeddedShop: "", sourceShop: embeddedShop },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const batches = new Map();

  for (const row of rows) {
    // Rows written before batching existed stand alone under their own id.
    const key = row.batchId || `single-${row.id}`;
    if (!batches.has(key)) {
      batches.set(key, {
        batchId: key,
        createdAt: row.createdAt.toISOString(),
        sourceThemeName: row.sourceThemeName,
        copiedBy: row.copiedBy,
        // The templates are the same across every row in a batch.
        templates: JSON.parse(row.filesJson).map((f) => f.filename),
        targets: [],
      });
    }
    batches.get(key).targets.push(hydrate(row));
  }

  return [...batches.values()].map((batch) => ({
    ...batch,
    status: batch.targets.every((t) => t.status === "SUCCESS")
      ? "SUCCESS"
      : batch.targets.every((t) => t.status === "FAILED")
        ? "FAILED"
        : "PARTIAL",
    revertable: batch.targets.some((t) => t.revertable),
  }));
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

const FILES_DELETE_MUTATION = `#graphql
  mutation CopierThemeFilesDelete($themeId: ID!, $files: [String!]!) {
    themeFilesDelete(themeId: $themeId, files: $files) {
      deletedThemeFiles {
        filename
      }
      userErrors {
        filename
        message
      }
    }
  }
`;

// Undo one copy: put back exactly what the destination theme held before it, and
// delete the templates the copy created. Media is NOT reverted - an overwritten
// image can't be un-overwritten, and a newly uploaded one is harmless to leave.
export async function revertCopy(logId, embeddedShop) {
  const row = await prisma.themeCopyLog.findUnique({ where: { id: logId } });

  if (!row) throw new Error("That copy isn't in the history any more");
  // Scoped to the store viewing the app, so one store can't revert another's.
  // Old rows carried the viewing store in sourceShop, so accept that too.
  const owner = row.embeddedShop || row.sourceShop;
  if (owner !== embeddedShop) {
    throw new Error("That copy was made from a different store");
  }
  if (row.revertedAt) throw new Error("That copy has already been reverted");

  const previous = JSON.parse(row.previousJson ?? "[]");
  if (previous.length === 0) {
    throw new Error(
      "No pre-copy snapshot was saved for this one, so it can't be reverted here. Use the destination theme's version history.",
    );
  }

  const admin = await adminFor(row.targetShop);

  // Files that existed before go back to their old content; files this copy
  // created are removed entirely.
  const restore = previous.filter((f) => typeof f.content === "string");
  const remove = previous.filter((f) => f.content === null);
  const results = [];

  for (let i = 0; i < restore.length; i += UPSERT_BATCH_SIZE) {
    const batch = restore.slice(i, i + UPSERT_BATCH_SIZE);
    const body = await adminGraphql(admin, UPSERT_MUTATION, {
      themeId: row.targetThemeId,
      files: batch.map((f) => ({
        filename: f.filename,
        body: { type: "TEXT", value: f.content },
      })),
    });
    const payload = body.data?.themeFilesUpsert;
    for (const err of payload?.userErrors ?? []) {
      results.push({
        filename: err.filename ?? "(batch)",
        status: "FAILED",
        error: err.message,
      });
    }
    for (const file of payload?.upsertedThemeFiles ?? []) {
      results.push({ filename: file.filename, status: "RESTORED", error: null });
    }
  }

  if (remove.length > 0) {
    const body = await adminGraphql(admin, FILES_DELETE_MUTATION, {
      themeId: row.targetThemeId,
      files: remove.map((f) => f.filename),
    });
    const payload = body.data?.themeFilesDelete;
    for (const err of payload?.userErrors ?? []) {
      results.push({
        filename: err.filename ?? "(batch)",
        status: "FAILED",
        error: err.message,
      });
    }
    for (const file of payload?.deletedThemeFiles ?? []) {
      results.push({ filename: file.filename, status: "DELETED", error: null });
    }
  }

  const failed = results.filter((r) => r.status === "FAILED");
  if (failed.length === 0) {
    await prisma.themeCopyLog.update({
      where: { id: logId },
      data: { revertedAt: new Date() },
    });
  }

  return {
    targetShop: row.targetShop,
    targetThemeName: row.targetThemeName,
    results,
    reverted: failed.length === 0,
    error: failed.length
      ? failed.map((f) => `${f.filename}: ${f.error}`).join("; ")
      : null,
  };
}
