// Theme Dev - every store's themes in one view, with the operations you need
// when prepping a deploy: duplicate a theme (usually the live one), rename it,
// grab its ID for the deploy file, and clean up afterwards.
//
// Backs app/routes/app.theme-dev.jsx. Reaches other stores the same way the
// Template copier does: `unauthenticated.admin(shop)` against the offline session
// stored for each installed store.
//
// Every mutation here needs `write_themes`. Shopify's docs note that modifying
// themes can additionally require an exemption for App Store-distributed apps;
// for a custom/org app this is just the scope. Errors come back verbatim so a
// refusal is legible rather than silent.

import { unauthenticated } from "../shopify.server";
import { adminGraphql } from "./adminGraphql.server";
import {
  countryFlag,
  listDestinationShops,
  getShopInfo,
  sortStoresByRegion,
} from "./themeCopier.server";

const THEME_FIELDS = `
  id
  name
  role
  processing
  updatedAt
  createdAt
`;

const THEMES_QUERY = `#graphql
  query ThemeDevThemes($after: String) {
    themes(first: 50, after: $after) {
      nodes {
        ${THEME_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const DUPLICATE_MUTATION = `#graphql
  mutation ThemeDevDuplicate($id: ID!, $name: String) {
    themeDuplicate(id: $id, name: $name) {
      newTheme {
        ${THEME_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const RENAME_MUTATION = `#graphql
  mutation ThemeDevRename($id: ID!, $input: OnlineStoreThemeInput!) {
    themeUpdate(id: $id, input: $input) {
      theme {
        ${THEME_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PUBLISH_MUTATION = `#graphql
  mutation ThemeDevPublish($id: ID!) {
    themePublish(id: $id) {
      theme {
        ${THEME_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DELETE_MUTATION = `#graphql
  mutation ThemeDevDelete($id: ID!) {
    themeDelete(id: $id) {
      deletedThemeId
      userErrors {
        field
        message
      }
    }
  }
`;

// The numeric part of a theme GID - what the deploy file and theme editor URLs
// actually use.
export const numericThemeId = (gid) => String(gid ?? "").split("/").pop();

async function adminFor(shop) {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

// Surface Shopify's userErrors as a thrown Error so the caller reports the real
// reason ("not permitted", "theme is processing") instead of a generic failure.
function throwOnUserErrors(errors, fallback) {
  if (!errors?.length) return;
  throw new Error(
    errors
      .map((e) => {
        const field = Array.isArray(e.field) ? e.field.join(".") : e.field;
        return field ? `${e.message} (${field})` : e.message;
      })
      .join("; ") || fallback,
  );
}

async function listThemesWith(admin) {
  const nodes = [];
  let after = null;

  do {
    const body = await adminGraphql(admin, THEMES_QUERY, { after });
    const connection = body.data?.themes;
    if (!connection) break;
    nodes.push(...(connection.nodes ?? []));
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  // Live theme first (it's the one you duplicate for a deploy), then the rest
  // most-recently-edited first.
  return nodes.sort((a, b) => {
    if (a.role === "MAIN" && b.role !== "MAIN") return -1;
    if (b.role === "MAIN" && a.role !== "MAIN") return 1;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
}

// Every installed store with its themes, embedded store first. A store whose
// token has gone stale is still listed, flagged unreachable, so it's obvious
// something needs a reinstall rather than the store silently missing.
export async function listAllStoreThemes(admin, embeddedShop) {
  const [embeddedInfo, otherShops] = await Promise.all([
    getShopInfo(admin, embeddedShop).catch(() => ({
      shop: embeddedShop,
      name: embeddedShop,
      flag: "",
    })),
    listDestinationShops(embeddedShop),
  ]);

  const embedded = await (async () => {
    try {
      return {
        ...embeddedInfo,
        isEmbedded: true,
        reachable: true,
        themes: await listThemesWith(admin),
      };
    } catch (err) {
      return {
        ...embeddedInfo,
        isEmbedded: true,
        reachable: false,
        themes: [],
        error: err?.message ?? String(err),
      };
    }
  })();

  const others = await Promise.all(
    otherShops.map(async (shop) => {
      if (!shop.reachable) return { ...shop, themes: [] };
      try {
        return { ...shop, themes: await listThemesWith(await adminFor(shop.shop)) };
      } catch (err) {
        return {
          ...shop,
          themes: [],
          reachable: false,
          error: err?.message ?? String(err),
        };
      }
    }),
  );

  // Always AU, UK, EU, US - the store you're in doesn't jump to the top, so the
  // list reads the same whichever store you open the app from.
  return sortStoresByRegion([embedded, ...others]);
}

// Re-read one store's themes after a mutation, so the page updates just that
// store rather than reloading all four.
export async function refreshStoreThemes(shop) {
  return listThemesWith(await adminFor(shop));
}

export async function duplicateTheme(shop, themeId, name) {
  const admin = await adminFor(shop);
  const body = await adminGraphql(admin, DUPLICATE_MUTATION, {
    id: themeId,
    // Omit rather than send empty, so Shopify's own "Copy of ..." default applies.
    name: name?.trim() ? name.trim() : null,
  });

  const payload = body.data?.themeDuplicate;
  throwOnUserErrors(payload?.userErrors, "Duplicate failed");

  const newTheme = payload?.newTheme;
  if (!newTheme) throw new Error("Shopify didn't return the duplicated theme");
  return newTheme;
}

export async function renameTheme(shop, themeId, name) {
  if (!name?.trim()) throw new Error("A theme name is required");

  const admin = await adminFor(shop);
  const body = await adminGraphql(admin, RENAME_MUTATION, {
    id: themeId,
    input: { name: name.trim() },
  });

  const payload = body.data?.themeUpdate;
  throwOnUserErrors(payload?.userErrors, "Rename failed");
  return payload?.theme;
}

// Publishing swaps which theme customers see, instantly. The page confirms
// before calling this; there's no undo beyond publishing the old one back.
export async function publishTheme(shop, themeId) {
  const admin = await adminFor(shop);
  const body = await adminGraphql(admin, PUBLISH_MUTATION, { id: themeId });

  const payload = body.data?.themePublish;
  throwOnUserErrors(payload?.userErrors, "Publish failed");
  return payload?.theme;
}

export async function deleteTheme(shop, themeId) {
  const admin = await adminFor(shop);
  const body = await adminGraphql(admin, DELETE_MUTATION, { id: themeId });

  const payload = body.data?.themeDelete;
  throwOnUserErrors(payload?.userErrors, "Delete failed");
  return payload?.deletedThemeId ?? themeId;
}

export { countryFlag };
