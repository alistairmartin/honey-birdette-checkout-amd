// Syncs the custom.loyalty_tier customer metafield from a customer's loyalty
// tags. Each region (store) has its own tags of the form
// `cx-tier-<tier>-<region>` (e.g. cx-tier-gold-au, cx-tier-VIP-uk). When syncing
// a given store we only look at that store's region, find the customers carrying
// each tier tag, and write the matching tier name into the single-value metafield
// custom.loyalty_tier.
//
// The metafield is a single line text choice (Gold / Diamond / Platinum / VIP),
// NOT a list, so we write a plain string value.
import { adminGraphql } from "./adminGraphql.server";

export const METAFIELD_NAMESPACE = "custom";
export const METAFIELD_KEY = "loyalty_tier";
export const METAFIELD_TYPE = "single_line_text_field";

// myshopify domain -> region code used in the tags.
const SHOP_REGION = {
  "honey-birdette-2.myshopify.com": "au",
  "honey-birdette-uk.myshopify.com": "uk",
  "honeybirdette-us.myshopify.com": "us",
  "honey-birdette-eu.myshopify.com": "eu",
};

// Tag token -> metafield choice value. Order is the priority used when a single
// customer somehow carries more than one tier tag (first match wins).
const TIERS = [
  { tag: "VIP", value: "VIP" },
  { tag: "diamond", value: "Diamond" },
  { tag: "platinum", value: "Platinum" },
  { tag: "gold", value: "Gold" },
];

export function regionForShop(shop) {
  return SHOP_REGION[shop] ?? null;
}

export function tierTagsForRegion(region) {
  return TIERS.map((t) => ({ ...t, tag: `cx-tier-${t.tag}-${region}` }));
}

const CUSTOMERS_BY_TAG = `#graphql
  query CustomersByTag($q: String!, $cursor: String) {
    customers(first: 100, query: $q, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
          value
        }
      }
    }
  }`;

const METAFIELDS_SET = `#graphql
  mutation SetLoyaltyTier($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }`;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Pull every customer carrying `tag`, returning [{ id, current }].
async function customersWithTag(admin, tag) {
  const out = [];
  let cursor = null;
  // Quote the tag so values with hyphens are matched exactly.
  const q = `tag:'${tag}'`;
  do {
    const body = await adminGraphql(admin, CUSTOMERS_BY_TAG, { q, cursor });
    const conn = body?.data?.customers;
    for (const node of conn?.nodes ?? []) {
      out.push({ id: node.id, current: node.metafield?.value ?? null });
    }
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// Write the metafield in batches of 25 (the metafieldsSet limit).
async function writeTiers(admin, updates) {
  let updated = 0;
  const errors = [];
  for (const batch of chunk(updates, 25)) {
    const body = await adminGraphql(admin, METAFIELDS_SET, {
      metafields: batch.map((u) => ({
        ownerId: u.id,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: METAFIELD_TYPE,
        value: u.value,
      })),
    });
    const res = body?.data?.metafieldsSet;
    updated += res?.metafields?.length ?? 0;
    for (const e of res?.userErrors ?? []) {
      errors.push(`${(e.field || []).join(".")}: ${e.message}`);
    }
  }
  return { updated, errors };
}

// Sync every tier for a region. Set dryRun to count matches without writing.
export async function syncLoyaltyTiers(admin, region, { dryRun = false } = {}) {
  const tiers = tierTagsForRegion(region);
  // customerId -> chosen tier value (first match by TIERS priority wins).
  const chosen = new Map();
  // customerId -> current metafield value, to skip no-op writes.
  const currentById = new Map();
  const perTier = [];
  let conflicts = 0;

  for (const tier of tiers) {
    const customers = await customersWithTag(admin, tier.tag);
    let matched = 0;
    for (const c of customers) {
      matched += 1;
      currentById.set(c.id, c.current);
      if (chosen.has(c.id)) {
        if (chosen.get(c.id) !== tier.value) conflicts += 1;
        continue; // keep higher-priority tier already assigned
      }
      chosen.set(c.id, tier.value);
    }
    perTier.push({ tag: tier.tag, value: tier.value, matched });
  }

  // Only write customers whose metafield isn't already the chosen value.
  const updates = [];
  let alreadyCorrect = 0;
  for (const [id, value] of chosen) {
    if (currentById.get(id) === value) {
      alreadyCorrect += 1;
    } else {
      updates.push({ id, value });
    }
  }

  let updated = 0;
  let errors = [];
  if (!dryRun && updates.length) {
    const res = await writeTiers(admin, updates);
    updated = res.updated;
    errors = res.errors;
  }

  return {
    region,
    dryRun,
    perTier,
    customersMatched: chosen.size,
    alreadyCorrect,
    toUpdate: updates.length,
    updated,
    conflicts,
    errors,
  };
}
