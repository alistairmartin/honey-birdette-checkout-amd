// Loyalty exclusives: gift-with-purchase offers limited to Honey Club tiers,
// built at /app/loyalty/exclusives and run by the GWP engine (gwpAppV1.server.js).
//
// Tier gating, two layers:
//   1. Discount: syncConfigs() swaps a loyalty config's eligibility for the
//      Shopify customer segments of its tiers (segment per tier per region,
//      `customer_tags CONTAINS 'cx-tier-gold-au'`, created here on demand), so
//      Shopify itself only applies the gift discount to those customers.
//   2. Checkout: the gift-with-purchase extension asks
//      /api/checkout/loyalty-check for the buyer's tier and only offers the gift
//      when it's one of `eligible_tiers`.
//
// Redemption: on orders/create, tagGiftRedemptions() adds each redeemed gift's
// `customer_redeemed_tag` to the customer (tag + the custom.tags metafield the
// checkout reads), for every one-per-customer offer, loyalty or not.
import prisma from "../db.server";
import { adminGraphql } from "./adminGraphql.server";
import { regionForShop } from "./loyaltyTierSync.server";
import { LOYALTY_TIERS, isLoyaltyConfig } from "./loyalty.shared";

const SEGMENTS = `#graphql
  query LoyaltySegments {
    segments(first: 250) {
      nodes { id name query }
    }
  }`;

const SEGMENT_CREATE = `#graphql
  mutation LoyaltySegmentCreate($name: String!, $query: String!) {
    segmentCreate(name: $name, query: $query) {
      segment { id }
      userErrors { field message }
    }
  }`;

function tierTag(tier, region) {
  return `cx-tier-${tier.tag}-${region}`;
}

function segmentName(tier, region) {
  return `Honey Club ${tier.value} (${region.toUpperCase()})`;
}

// The customer tags that put a customer in each of `tierValues` on this shop.
export function tierTagsFor(shop, tierValues) {
  const region = regionForShop(shop);
  if (!region) return [];
  return LOYALTY_TIERS.filter((t) => tierValues.includes(t.value)).map((t) => tierTag(t, region));
}

// Segment ids for the given tiers, creating any that don't exist yet.
async function ensureTierSegments(admin, shop, tierValues) {
  const region = regionForShop(shop);
  if (!region) throw new Error(`No loyalty region configured for ${shop}`);

  const body = await adminGraphql(admin, SEGMENTS);
  const existing = body?.data?.segments?.nodes ?? [];
  const ids = [];
  for (const tier of LOYALTY_TIERS.filter((t) => tierValues.includes(t.value))) {
    const query = `customer_tags CONTAINS '${tierTag(tier, region)}'`;
    const found = existing.find((s) => s.query === query || s.name === segmentName(tier, region));
    if (found) {
      ids.push(found.id);
      continue;
    }
    const created = await adminGraphql(admin, SEGMENT_CREATE, { name: segmentName(tier, region), query });
    const errors = created?.data?.segmentCreate?.userErrors ?? [];
    const id = created?.data?.segmentCreate?.segment?.id;
    if (errors.length || !id) {
      throw new Error(`segmentCreate ${segmentName(tier, region)} failed: ${errors.map((e) => e.message).join("; ")}`);
    }
    ids.push(id);
  }
  return ids;
}

// The config as the engine should run it: for a loyalty exclusive, eligibility
// becomes its tier segments and the tier tags are stamped on for the checkout.
// Non-loyalty configs pass through untouched. With no tiers picked the offer is
// left with no eligible customers rather than opened up to everyone.
export async function applyLoyaltyEligibility(admin, shop, config) {
  if (!isLoyaltyConfig(config)) return config;
  const tiers = Array.isArray(config.eligible_tiers) ? config.eligible_tiers : [];
  const segmentIds = tiers.length ? await ensureTierSegments(admin, shop, tiers) : [];
  return {
    ...config,
    eligibility: "segments",
    eligible_segment_ids: segmentIds,
    eligible_tier_tags: tierTagsFor(shop, tiers),
  };
}

// --------------------------------------------------------------------------
// Redemption tagging (orders/create)
// --------------------------------------------------------------------------

const CUSTOMER_TAGS_METAFIELD = `#graphql
  query RedeemedTagsMetafield($id: ID!) {
    customer(id: $id) {
      metafield(namespace: "custom", key: "tags") { type value }
    }
  }`;

const TAGS_ADD = `#graphql
  mutation RedeemedTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }`;

const METAFIELDS_SET = `#graphql
  mutation RedeemedTagsMetafieldSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

const numericId = (value) => String(value ?? "").match(/(\d+)$/)?.[1] ?? "";

// Every gift product a config can hand out, as numeric ids.
function giftProductIds(config) {
  const ids = [config.product_id];
  if (Array.isArray(config.gift_options)) {
    for (const opt of config.gift_options) ids.push(opt && typeof opt === "object" ? opt.product_id : opt);
  }
  return ids.map(numericId).filter(Boolean);
}

function isOnePerCustomer(config) {
  const type = config.redemption_type ?? (config.customer_redeemed_tag ? "one_per_customer" : "one_per_order");
  return type === "one_per_customer" && String(config.customer_redeemed_tag || "").trim() !== "";
}

// custom.tags is read by the checkout (it can't see real customer tags). Its
// type varies by store, so append in whatever shape is already there.
function mergeTagsValue(type, value, add) {
  let current = [];
  if (value) {
    try {
      const parsed = JSON.parse(value);
      current = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      current = String(value).split(/\s*,\s*/).filter(Boolean);
    }
  }
  const lower = current.map((t) => t.toLowerCase());
  const merged = [...current, ...add.filter((t) => !lower.includes(t.toLowerCase()))];
  const resolvedType = type || "list.single_line_text_field";
  const out = resolvedType.startsWith("list.") ? JSON.stringify(merged) : merged.join(", ");
  return { type: resolvedType, value: out, changed: merged.length !== current.length };
}

// Gift lines are stamped with the `_promo=true` line property by the checkout
// extension; match them to one-per-customer offers by gift product.
export async function tagGiftRedemptions(admin, shop, order) {
  const customerId = order?.customer?.admin_graphql_api_id;
  if (!customerId) return { tagged: [] };

  const giftProducts = (order.line_items || [])
    .filter((line) =>
      (line.properties || []).some((p) => p?.name === "_promo" && String(p?.value) === "true"),
    )
    .map((line) => String(line.product_id ?? ""))
    .filter(Boolean);
  if (!giftProducts.length) return { tagged: [] };

  const rows = await prisma.gwpAppV1Config.findMany({ where: { shop } });
  const tags = new Set();
  for (const row of rows) {
    let config;
    try {
      config = JSON.parse(row.configJson);
    } catch {
      continue;
    }
    if (!config || !isOnePerCustomer(config)) continue;
    if (giftProductIds(config).some((id) => giftProducts.includes(id))) {
      tags.add(String(config.customer_redeemed_tag).trim());
    }
  }
  if (!tags.size) return { tagged: [] };
  const list = [...tags];

  const added = await adminGraphql(admin, TAGS_ADD, { id: customerId, tags: list });
  const tagErrors = added?.data?.tagsAdd?.userErrors ?? [];
  if (tagErrors.length) throw new Error(`tagsAdd failed: ${tagErrors.map((e) => e.message).join("; ")}`);

  const current = await adminGraphql(admin, CUSTOMER_TAGS_METAFIELD, { id: customerId });
  const mf = current?.data?.customer?.metafield;
  const merged = mergeTagsValue(mf?.type, mf?.value, list);
  if (merged.changed) {
    const set = await adminGraphql(admin, METAFIELDS_SET, {
      metafields: [{ ownerId: customerId, namespace: "custom", key: "tags", type: merged.type, value: merged.value }],
    });
    const mfErrors = set?.data?.metafieldsSet?.userErrors ?? [];
    if (mfErrors.length) throw new Error(`custom.tags update failed: ${mfErrors.map((e) => e.message).join("; ")}`);
  }

  return { tagged: list };
}
