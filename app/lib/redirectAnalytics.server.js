// Aggregates geo-redirect tracking data off orders.
//
// When a customer arrives via the regionalisation popup / auto-redirect, the
// destination URL carries tracking params (see cart-redirect-attribute.liquid):
//   ?country=US&hb_redirect_from=AU&detected_country=US
// which land on the order as hidden custom attributes:
//   _hb_redirect_from  - the store the customer was redirected FROM (AU|UK|EU|US)
//   _detected_country  - the geo-detected country ISO (US, NL, ...)
//   _country           - the country/currency context they landed on
//
// This sweeps orders in a date window, reads those attributes, and returns
// partial aggregate counts per batch. The browser resumes with the cursor and
// merges the partials, so large order volumes never blow a single request.

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { adminGraphql, costPause, sleep, BUDGET_MS } from "./adminGraphql.server";
import { getShopInfo } from "./themeCopier.server";
import { canonicalStore } from "./redirectAnalytics.shared";

// Every store the app is installed on (one offline session each). Returns
// merchant-facing name + region + flag so the dashboard can label each store,
// and marks unreachable installs (stale token) instead of hiding them.
export async function listInstalledShops() {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
    orderBy: { shop: "asc" },
  });

  return Promise.all(
    sessions.map(async ({ shop }) => {
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

// An admin client for any installed shop, loaded from its offline session.
export async function adminForShop(shop) {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

const ATTR_FROM = "_hb_redirect_from";
const ATTR_DETECTED = "_detected_country";
const ATTR_COUNTRY = "_country";

const ORDERS_QUERY = `#graphql
  query RedirectAnalyticsOrders($q: String!, $cursor: String) {
    orders(first: 100, query: $q, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        legacyResourceId
        createdAt
        customAttributes { key value }
      }
    }
  }`;

// Cap the raw per-batch order sample so a huge window can't balloon the response
// or the browser's memory. The aggregate counts are always complete; only the
// drill-down list is sampled once this many redirected orders are collected.
const MAX_SAMPLE = 500;

function getAttr(order, key) {
  const v = order.customAttributes?.find((a) => a.key === key)?.value;
  return v ? String(v).trim().toUpperCase() : null;
}


function bump(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

// Scan one batch of orders and return partial aggregates + a resume cursor.
// `sinceISO` (optional) bounds the window to orders created on/after that time.
export async function scanBatch({ admin, cursor, sinceISO }) {
  const q = sinceISO ? `created_at:>='${sinceISO}'` : "";

  const partial = {
    scanned: 0,
    redirected: 0,
    byOrigin: {},
    byDetected: {},
    byCountry: {},
    flows: {}, // "AU>US" -> count
    orders: [], // per-order drill-down sample (capped at MAX_SAMPLE)
    sampleCapped: false,
    errors: [],
  };

  const start = Date.now();
  let cur = cursor || null;
  let hasNext = true;

  while (hasNext && Date.now() - start < BUDGET_MS) {
    let body;
    try {
      body = await adminGraphql(admin, ORDERS_QUERY, { q, cursor: cur });
    } catch (err) {
      partial.errors.push(err?.message || String(err));
      return { ...partial, nextCursor: cur, done: false, fatal: err?.message || String(err) };
    }

    const conn = body?.data?.orders;
    if (!conn) {
      return { ...partial, nextCursor: cur, done: true };
    }

    for (const order of conn.nodes) {
      partial.scanned += 1;
      const from = canonicalStore(getAttr(order, ATTR_FROM));
      const detected = getAttr(order, ATTR_DETECTED);
      const country = getAttr(order, ATTR_COUNTRY);

      if (from || detected) {
        partial.redirected += 1;
        bump(partial.byOrigin, from || "(unknown)");
        bump(partial.byDetected, detected || "(unknown)");
        if (country) bump(partial.byCountry, country);
        bump(partial.flows, `${from || "(unknown)"}>${detected || "(unknown)"}`);

        if (partial.orders.length < MAX_SAMPLE) {
          partial.orders.push({
            name: order.name,
            legacyId: order.legacyResourceId,
            createdAt: order.createdAt,
            from: from || "",
            detected: detected || "",
            country: country || "",
          });
        } else {
          partial.sampleCapped = true;
        }
      }
    }

    hasNext = conn.pageInfo.hasNextPage;
    cur = conn.pageInfo.endCursor;

    const pause = costPause(body);
    if (pause) await sleep(pause);
  }

  return { ...partial, nextCursor: cur, done: !hasNext };
}
