// Backfills a `Loyalty:<Tier>` order tag from the ordering customer's loyalty
// tags (cx-tier-<tier>-<region>). Mirrors the Shopify Flow "Order created"
// workflow so orders placed before the Flow went live carry the same tag.
//
// Only orders in a recent window are scanned; each request processes for at
// most BUDGET_MS and hands back a cursor so the browser can resume.
import { adminGraphql, costPause, sleep, BUDGET_MS } from "./adminGraphql.server";
import { tierTagsForRegion } from "./loyaltyTierSync.server";

export const ORDER_TAG_PREFIX = "Loyalty:";

const ORDERS_QUERY = `#graphql
  query OrdersForLoyaltyTags($q: String!, $cursor: String) {
    orders(first: 100, query: $q, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        tags
        customer { tags }
      }
    }
  }`;

const TAGS_ADD = `#graphql
  mutation AddLoyaltyOrderTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }`;

// Pick the tier for a customer's tags. Tag comparison is case-insensitive
// because the VIP tag is capitalised (cx-tier-VIP-au) while others are not.
export function tierForCustomerTags(customerTags, region) {
  if (!customerTags?.length) return null;
  const lower = customerTags.map((t) => t.toLowerCase());
  for (const tier of tierTagsForRegion(region)) {
    if (lower.includes(tier.tag.toLowerCase())) return tier.value;
  }
  return null;
}

export function hasLoyaltyOrderTag(orderTags) {
  return (orderTags ?? []).some((t) => t.startsWith(ORDER_TAG_PREFIX));
}

const MAX_ERRORS = 50;

// Process one budgeted batch. Returns page counts plus a cursor to resume from
// (null when the window is exhausted).
export async function backfillOrderLoyaltyTags(
  admin,
  region,
  { days = 7, apply = false, cursor = null } = {},
) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const q = `created_at:>='${since}'`;
  const deadline = Date.now() + BUDGET_MS;

  let scanned = 0;
  let matched = 0;
  let alreadyTagged = 0;
  let noTier = 0;
  let tagged = 0;
  let done = false;
  const errors = [];
  const perTier = {};
  // What each matched order would get / got, so the UI can list them.
  const matchedOrders = [];

  try {
    while (true) {
      const body = await adminGraphql(admin, ORDERS_QUERY, { q, cursor });
      const orders = body.data.orders;

      for (const order of orders.nodes) {
        scanned++;
        if (hasLoyaltyOrderTag(order.tags)) {
          alreadyTagged++;
          continue;
        }
        const tier = tierForCustomerTags(order.customer?.tags, region);
        if (!tier) {
          noTier++;
          continue;
        }
        matched++;
        perTier[tier] = (perTier[tier] ?? 0) + 1;
        const tag = `${ORDER_TAG_PREFIX}${tier}`;
        matchedOrders.push({ name: order.name, tag });
        if (!apply) continue;

        const upd = await adminGraphql(admin, TAGS_ADD, {
          id: order.id,
          tags: [tag],
        });
        const userErrors = upd.data.tagsAdd.userErrors || [];
        if (userErrors.length) {
          if (errors.length < MAX_ERRORS) {
            errors.push(
              `${order.name}: ${userErrors.map((e) => e.message).join(", ")}`,
            );
          }
        } else {
          tagged++;
        }
        const pause = costPause(upd);
        if (pause) await sleep(pause);
      }

      cursor = orders.pageInfo.hasNextPage ? orders.pageInfo.endCursor : null;
      if (!cursor) {
        done = true;
        break;
      }
      if (Date.now() > deadline) break;
    }
  } catch (err) {
    return {
      apply,
      days,
      done: true,
      nextCursor: null,
      pageScanned: scanned,
      pageMatched: matched,
      pageAlreadyTagged: alreadyTagged,
      pageNoTier: noTier,
      pageTagged: tagged,
      perTier,
      matchedOrders,
      errors,
      fatalError: err?.message || String(err),
    };
  }

  return {
    apply,
    days,
    done,
    nextCursor: cursor,
    pageScanned: scanned,
    pageMatched: matched,
    pageAlreadyTagged: alreadyTagged,
    pageNoTier: noTier,
    pageTagged: tagged,
    perTier,
    matchedOrders,
    errors,
    fatalError: null,
  };
}
