// Exclusive gifts in the customer account (honey-club-page extension).
//
// Lists the tier-gated gift offers (loyalty exclusives, and GWP offers with
// "Honey Club tiers" eligibility) that have "Show in customer account" ticked,
// limited to the ones this customer can actually get right now:
//   - config enabled, live (not test mode), inside its valid dates
//   - customer's Honey Club tier (cx-tier-<tier>-<region> tag) is eligible
//   - customer doesn't already carry the offer's redeemed tag
// Display only: checkout and the discount still enforce everything.
import prisma from "../db.server";
import { adminGraphql } from "./adminGraphql.server";
import { regionForShop } from "./loyaltyTierSync.server";
import { tierForCustomerTags } from "./loyaltyOrderTags.server";
import { isTierGatedConfig } from "./loyalty.shared";
import { DEFAULT_STORE_TIMEZONE, discountDatesFor } from "./gwpAppV1.server";

const CONTEXT = `#graphql
  query AccountGiftsContext($id: ID!) {
    customer(id: $id) { tags }
    shop { ianaTimezone currencyCode }
  }`;

const PRODUCTS = `#graphql
  query AccountGiftProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        featuredImage { url }
      }
    }
  }`;

const numericId = (value) => String(value ?? "").match(/(\d+)$/)?.[1] ?? "";
const str = (value) => (typeof value === "string" ? value.trim() : "");

function inWindow(config, timeZone, now = Date.now()) {
  const hasStart = Boolean(config.valid_date_from);
  const { startsAt, endsAt } = discountDatesFor(config, timeZone);
  if (hasStart && now < new Date(startsAt).getTime()) return false;
  if (endsAt && now > new Date(endsAt).getTime()) return false;
  return true;
}

function hasRedeemed(config, tagsLower) {
  const tag = str(config.customer_redeemed_tag).toLowerCase();
  return Boolean(tag) && tagsLower.includes(tag);
}

export async function getAccountGifts(admin, shop, customerId) {
  const region = regionForShop(shop);
  if (!region) return { gifts: [] };

  const rows = await prisma.gwpAppV1Config.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
  const candidates = [];
  for (const row of rows) {
    let config;
    try {
      config = JSON.parse(row.configJson);
    } catch {
      continue;
    }
    if (!config || !isTierGatedConfig(config) || config.show_in_account !== true) continue;
    if (config.enabled === false || String(config.mode || "live").toLowerCase() === "test") continue;
    candidates.push({ row, config });
  }
  if (!candidates.length) return { gifts: [] };

  const ctx = await adminGraphql(admin, CONTEXT, { id: customerId });
  const tags = ctx?.data?.customer?.tags ?? [];
  const tagsLower = tags.map((t) => t.toLowerCase());
  const tier = tierForCustomerTags(tags, region);
  if (!tier) return { gifts: [] };
  const timeZone = ctx?.data?.shop?.ianaTimezone || DEFAULT_STORE_TIMEZONE;
  const currency = ctx?.data?.shop?.currencyCode || "AUD";

  const eligible = candidates.filter(
    ({ config }) =>
      (config.eligible_tiers || []).some((t) => String(t).toLowerCase() === tier.toLowerCase()) &&
      inWindow(config, timeZone) &&
      !hasRedeemed(config, tagsLower),
  );
  if (!eligible.length) return { gifts: [] };

  const productIds = [...new Set(eligible.map(({ config }) => numericId(config.product_id)).filter(Boolean))];
  const products = {};
  if (productIds.length) {
    const body = await adminGraphql(admin, PRODUCTS, {
      ids: productIds.map((id) => `gid://shopify/Product/${id}`),
    });
    for (const node of body?.data?.nodes ?? []) {
      if (node?.id) products[numericId(node.id)] = node;
    }
  }

  const gifts = eligible.map(({ row, config }) => {
    const product = products[numericId(config.product_id)];
    const minSpend = Number(config[`min_spend_${currency}`]);
    return {
      id: row.id,
      tier,
      giftTitle: product?.title || "",
      image: str(config.account_image_url) || product?.featuredImage?.url || "",
      heading: str(config.account_heading),
      message: str(config.account_message),
      ctaText: str(config.account_cta_text),
      ctaUrl: str(config.account_cta_url),
      // For the default message ("Free with orders over $150").
      minSpend: String(config.trigger_type || "min_spend").includes("min_spend") && minSpend > 0 ? minSpend : null,
      currency,
    };
  });
  return { gifts };
}
