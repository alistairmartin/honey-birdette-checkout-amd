// Server helpers for the "Email banner" admin page.
//
// The weekly campaign banner at the top of every notification email template is
// stored as a SHOP metafield (email.banner_url) instead of being hardcoded in
// each template. Templates reference it once with
//   {%- assign image_banner_url = shop.metafields.email.banner_url -%}
// and after that only the metafield changes each week. A fresh CDN URL per
// campaign also sidesteps email clients caching the old image behind a reused
// URL.
//
// The namespace is store-owned (not $app) on purpose: notification email Liquid
// reads app-reserved namespaces as shop.metafields.app--<id>--<ns>.<key>, which
// is fragile in templates. A plain `email` namespace keeps the Liquid readable
// and lets the merchant edit the value from Settings > Custom data too.
//
// The page runs on whichever store the app is embedded in, but saving fans out
// to every store the app is installed on via each store's offline session -
// same trick as the Template copier and Redirect analytics pages.

import { unauthenticated } from "../shopify.server";
import { listInstalledShops } from "./redirectAnalytics.server";
import { sortStoresByRegion } from "./themeCopier.server";

export const EMAIL_BANNER_NAMESPACE = "email";
export const EMAIL_BANNER_KEY = "banner_url";

const GET_BANNER = `#graphql
  query EmailBanner {
    shop {
      id
      metafield(namespace: "${EMAIL_BANNER_NAMESPACE}", key: "${EMAIL_BANNER_KEY}") {
        value
        updatedAt
      }
    }
  }
`;

const DEFINITION_QUERY = `#graphql
  query EmailBannerDefinition {
    metafieldDefinitions(first: 1, ownerType: SHOP, namespace: "${EMAIL_BANNER_NAMESPACE}", key: "${EMAIL_BANNER_KEY}") {
      nodes { id }
    }
  }
`;

const DEFINITION_CREATE = `#graphql
  mutation EmailBannerDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

const SET_BANNER = `#graphql
  mutation EmailBannerSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }
  return payload.data;
}

// Create the definition if this store doesn't have it yet. Idempotent: a TAKEN
// userError (someone created it concurrently) counts as success. `access` is
// deliberately omitted so Shopify defaults a store-owned namespace correctly
// (see the note in metafieldDefinitions.server.js).
export async function ensureEmailBannerDefinition(admin) {
  const existing = await gql(admin, DEFINITION_QUERY);
  if (existing?.metafieldDefinitions?.nodes?.length) return;

  const data = await gql(admin, DEFINITION_CREATE, {
    definition: {
      namespace: EMAIL_BANNER_NAMESPACE,
      key: EMAIL_BANNER_KEY,
      name: "Email banner URL",
      description:
        "Campaign banner image shown at the top of every notification email template. Read in Liquid as shop.metafields.email.banner_url.",
      ownerType: "SHOP",
      type: "url",
    },
  });
  const errors = data?.metafieldDefinitionCreate?.userErrors ?? [];
  const failed = errors.filter((e) => e.code !== "TAKEN");
  if (!data?.metafieldDefinitionCreate?.createdDefinition && failed.length) {
    throw new Error(failed.map((e) => e.message).join(", "));
  }
}

// Current banner URL on one store. Returns { shopId, url, updatedAt }.
export async function getEmailBanner(admin) {
  const data = await gql(admin, GET_BANNER);
  return {
    shopId: data?.shop?.id ?? null,
    url: data?.shop?.metafield?.value ?? "",
    updatedAt: data?.shop?.metafield?.updatedAt ?? null,
  };
}

// Write the banner URL to one store, creating the definition first if needed.
export async function setEmailBanner(admin, url) {
  await ensureEmailBannerDefinition(admin);
  const { shopId } = await getEmailBanner(admin);
  if (!shopId) throw new Error("Could not resolve shop id");

  const data = await gql(admin, SET_BANNER, {
    metafields: [
      {
        ownerId: shopId,
        namespace: EMAIL_BANNER_NAMESPACE,
        key: EMAIL_BANNER_KEY,
        type: "url",
        value: url,
      },
    ],
  });
  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(", "));
  }
}

// Every installed store with its current banner value, region-sorted for the
// page. Unreachable stores (stale offline token) are reported, not hidden.
export async function listBannerStatus() {
  const shops = await listInstalledShops();
  const withBanners = await Promise.all(
    shops.map(async (info) => {
      if (!info.reachable) return { ...info, url: "", updatedAt: null };
      try {
        const { admin } = await unauthenticated.admin(info.shop);
        const { url, updatedAt } = await getEmailBanner(admin);
        return { ...info, url, updatedAt };
      } catch (err) {
        return {
          ...info,
          reachable: false,
          url: "",
          updatedAt: null,
          error: err?.message ?? String(err),
        };
      }
    }),
  );
  return sortStoresByRegion(withBanners);
}

// Apply one URL to every reachable store. Returns per-store results so the page
// can show exactly which regions took the update.
export async function applyEmailBannerEverywhere(url) {
  const shops = await listInstalledShops();
  return Promise.all(
    shops.map(async (info) => {
      if (!info.reachable) {
        return { shop: info.shop, ok: false, error: info.error || "Store unreachable" };
      }
      try {
        const { admin } = await unauthenticated.admin(info.shop);
        await setEmailBanner(admin, url);
        return { shop: info.shop, ok: true };
      } catch (err) {
        return { shop: info.shop, ok: false, error: err?.message ?? String(err) };
      }
    }),
  );
}
