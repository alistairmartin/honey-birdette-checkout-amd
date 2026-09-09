// Admin API lookups for the webhook monitor's bar drill-down. Kept out of
// webhookMonitor.server.js so that module stays DB-only. Nothing here is
// stored: inventory item ids from the recorded rows are turned into product
// and variant names on the fly so the modal can link them, and the answers
// are cached in memory for a while because the same items fire repeatedly.

import { unauthenticated } from "../shopify.server";

const CACHE_TTL_MS = 6 * 60 * 60e3;
const cache = new Map(); // `${shop}|${gid}` -> { value, at }

function gidNumber(gid) {
  return gid ? String(gid).split("/").pop() : null;
}

const NODES_QUERY = `#graphql
  query WebhookMonitorRefs($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        sku
        variant {
          id
          title
          displayName
          product { id title }
        }
      }
      ... on Location { id name }
    }
  }
`;

function shapeNode(n) {
  if (!n) return null;
  if (n.name !== undefined && n.variant === undefined) {
    return { kind: "location", name: n.name };
  }
  const v = n.variant;
  return {
    kind: "inventory_item",
    sku: n.sku || null,
    variantId: gidNumber(v?.id),
    variantTitle: v?.title || null,
    displayName: v?.displayName || null,
    productId: gidNumber(v?.product?.id),
    productTitle: v?.product?.title || null,
  };
}

// events: rows from readBucketEvents. Returns
// { inventoryItems: { [id]: ref }, locations: { [id]: name } }. Empty maps
// when the shop has no offline session or the lookup fails.
export async function resolveInventoryRefs(shop, events) {
  const itemIds = new Set();
  const locationIds = new Set();
  for (const e of events) {
    if (e.resourceType === "inventory_level") {
      const [item, loc] = String(e.resourceId).split(":");
      if (item && item !== "undefined") itemIds.add(item);
      if (loc && loc !== "undefined") locationIds.add(loc);
    } else if (e.resourceType === "inventory_item") {
      itemIds.add(String(e.resourceId));
    }
  }
  const gids = [
    ...[...itemIds].map((id) => `gid://shopify/InventoryItem/${id}`),
    ...[...locationIds].map((id) => `gid://shopify/Location/${id}`),
  ];
  const result = { inventoryItems: {}, locations: {} };
  if (!gids.length) return result;

  const now = Date.now();
  const missing = [];
  for (const gid of gids) {
    const hit = cache.get(`${shop}|${gid}`);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      place(result, gid, hit.value);
    } else {
      missing.push(gid);
    }
  }

  if (missing.length) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      for (let i = 0; i < missing.length; i += 100) {
        const chunk = missing.slice(i, i + 100);
        const res = await admin.graphql(NODES_QUERY, { variables: { ids: chunk } });
        const body = await res.json();
        const nodes = body?.data?.nodes || [];
        chunk.forEach((gid, idx) => {
          const value = shapeNode(nodes[idx]);
          cache.set(`${shop}|${gid}`, { value, at: now });
          place(result, gid, value);
        });
      }
    } catch (err) {
      console.error("[webhook-monitor] ref lookup failed", shop, err?.message);
    }
  }
  return result;
}

function place(result, gid, value) {
  const id = gidNumber(gid);
  if (!value) return;
  if (value.kind === "location") result.locations[id] = value.name;
  else result.inventoryItems[id] = value;
}
