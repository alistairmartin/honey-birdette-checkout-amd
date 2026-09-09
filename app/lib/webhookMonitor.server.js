// Webhook monitor: classify, fingerprint, record, roll up, prune.
//
// Background: WEBHOOK_MONITOR_HANDOFF.md. The legacy order backend queues every
// Shopify webhook as a file, and on 8 Sep 2026 the AU queue hit ~5,000 files
// with nobody able to say what was arriving or why. Most of it turned out to be
// AusPost tracking scans re-firing `orders/updated` on fulfilled, closed orders.
//
// This module gives the app a cheap "what is Shopify emitting" record. The
// classify* / fingerprint* functions are pure (payload in, strings out) so they
// can be unit tested against saved payloads. Nothing here calls the Admin API,
// and nothing here stores PII: contact fields are hashed before they are
// compared, and only ids, statuses, tags, counts and hashes are written.

import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import prisma from "../db.server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Topics the handler records. Anything else falls through to the existing
// switch in app/routes/webhooks.jsx.
export const MONITORED_TOPICS = new Set([
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_PAID",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
  "ORDERS_EDITED",
  "ORDERS_DELETE",
  "REFUNDS_CREATE",
  "CUSTOMERS_DELETE",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "INVENTORY_ITEMS_UPDATE",
  "RETURNS_REQUEST",
  "RETURNS_APPROVE",
  "RETURNS_DECLINE",
  "RETURNS_CANCEL",
  "RETURNS_CLOSE",
  "RETURNS_REOPEN",
  "RETURNS_UPDATE",
  "DRAFT_ORDERS_CREATE",
  "DRAFT_ORDERS_UPDATE",
  "DRAFT_ORDERS_DELETE",
  "FULFILLMENTS_CREATE",
  "FULFILLMENTS_UPDATE",
  "FULFILLMENT_EVENTS_CREATE",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "INVENTORY_LEVELS_UPDATE",
]);

// Classifications the dashboard counts as noise: nothing a backend cares about
// changed. `repeatOfPrev` rows are counted as noise too regardless of class.
export const NOISE_CLASSES = new Set(["tracking_only", "silent"]);

// Raw rows live this long (about 2 GB for 4 regions on a busy month, see
// WEBHOOK_MONITOR_HANDOFF.md). The hourly rollup keeps windows over
// RAW_WINDOW_DAYS cheap: the dashboard and the rollup cron only ever read
// RAW_WINDOW_DAYS of raw rows at a time; the bar drill-down and recent events
// read by bucket or by limit, so they can reach the full retention.
export const RAW_RETENTION_DAYS = 30;
export const RAW_WINDOW_DAYS = 3;
// Raw bodies (gzipped, PII included) live this long so the drill-down can show
// a message as received. Roughly 2 KB each compressed.
export const PAYLOAD_RETENTION_DAYS = 3;
export const HOURLY_RETENTION_DAYS = 90;
export const QUEUE_SAMPLE_RETENTION_DAYS = 30;

// The four production regions plus the dev store. Used to label the shop
// selector; anything else installed still shows up under its domain.
export const KNOWN_SHOPS = {
  "honey-birdette-2.myshopify.com": "AU",
  "honeybirdette-us.myshopify.com": "US",
  "honey-birdette-usa.myshopify.com": "US",
  "honey-birdette-uk.myshopify.com": "UK",
  "honey-birdette-eu.myshopify.com": "EU",
  "amd-checkout-2024.myshopify.com": "Dev",
};

export function shopLabel(shop) {
  const region = KNOWN_SHOPS[shop];
  return region ? `${region} (${shop})` : shop;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function sha1(value) {
  return createHash("sha1").update(String(value ?? "")).digest("hex");
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function secondsBetween(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return null;
  return (db.getTime() - da.getTime()) / 1000;
}

function tagList(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  return String(tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseSummary(row) {
  if (!row?.summaryJson) return {};
  try {
    return JSON.parse(row.summaryJson);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// The non-PII parts of an order payload that a backend would act on. The
// fingerprint is a hash of this; the summary is stored so the NEXT row for the
// same order can say which of these moved.
export function summarizeOrder(p) {
  const refunds = Array.isArray(p?.refunds) ? p.refunds : [];
  const fulfillments = Array.isArray(p?.fulfillments) ? p.fulfillments : [];
  return {
    financial_status: p?.financial_status ?? null,
    fulfillment_status: p?.fulfillment_status ?? null,
    closed_at: p?.closed_at ?? null,
    cancelled_at: p?.cancelled_at ?? null,
    tags: tagList(p?.tags).sort().join(","),
    note_hash: p?.note ? sha1(p.note) : "",
    refunds: refunds.length,
    fulfillments: fulfillments
      .map((f) => `${f?.status ?? ""}:${f?.tracking_number ?? ""}`)
      .join("|"),
    total_price: p?.total_price ?? null,
  };
}

export function fingerprintOrder(p) {
  return sha1(JSON.stringify(summarizeOrder(p)));
}

// Fulfilled, closed, paid order touched well after close with no later refund.
// The AusPost tracking-scan signature (same heuristic as scripts/webhook_triage.py).
export function isTrackingOnly(p) {
  if (p?.fulfillment_status !== "fulfilled") return false;
  if (!["paid", "partially_refunded", "refunded"].includes(p?.financial_status)) {
    return false;
  }
  const closed = toDate(p?.closed_at);
  const updated = toDate(p?.updated_at);
  if (!closed || !updated) return false;
  if (updated.getTime() - closed.getTime() < 5 * 60 * 1000) return false;
  for (const r of p?.refunds ?? []) {
    const rt = toDate(r?.created_at);
    if (rt && rt > closed) return false;
  }
  return true;
}

function hasRefundAfterClose(p) {
  const closed = toDate(p?.closed_at);
  const refunds = Array.isArray(p?.refunds) ? p.refunds : [];
  if (!refunds.length) return false;
  if (!closed) return true; // open order with any refund
  return refunds.some((r) => {
    const rt = toDate(r?.created_at);
    return rt && rt > closed;
  });
}

// `prevSummary` is the stored summary of the previous row for this order (or
// null when this is the first we have seen of it).
export function classifyOrder(topic, p, prevSummary) {
  if (topic === "ORDERS_CREATE") return "new_order";
  if (topic === "ORDERS_CANCELLED") return "cancelled";
  if (topic === "ORDERS_PAID") return "paid";
  if (topic === "ORDERS_FULFILLED") return "fulfilled";
  if (topic === "ORDERS_PARTIALLY_FULFILLED") return "partially_fulfilled";
  if (topic === "ORDERS_DELETE") return "deleted";

  const sinceCreate = secondsBetween(p?.created_at, p?.updated_at);
  if (sinceCreate !== null && Math.abs(sinceCreate) <= 60) return "new_order";
  if (p?.cancelled_at) return "cancelled";

  const now = summarizeOrder(p);
  if (prevSummary && prevSummary.refunds !== undefined) {
    if (now.refunds > prevSummary.refunds) return "refund";
  } else if (hasRefundAfterClose(p)) {
    return "refund";
  }

  if (prevSummary && prevSummary.fulfillment_status !== undefined) {
    if (now.fulfillment_status !== prevSummary.fulfillment_status) return "fulfilled";
  }

  if (isTrackingOnly(p)) return "tracking_only";

  if (prevSummary && prevSummary.fulfillment_status !== undefined) {
    const changed = Object.keys(now).filter((k) => now[k] !== prevSummary[k]);
    if (changed.length && changed.every((k) => k === "tags" || k === "note_hash")) {
      return "tag_or_note";
    }
  }

  return "other";
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export function summarizeCustomer(p) {
  const addresses = Array.isArray(p?.addresses) ? p.addresses : [];
  return {
    orders_count: p?.orders_count ?? null,
    total_spent: p?.total_spent ?? null,
    tags: tagList(p?.tags).sort().join(","),
    state: p?.state ?? null,
    addresses: addresses.length,
    email_hash: p?.email ? sha1(String(p.email).toLowerCase()) : "",
    phone_hash: p?.phone ? sha1(p.phone) : "",
    email_consent: p?.email_marketing_consent?.state ?? null,
    sms_consent: p?.sms_marketing_consent?.state ?? null,
  };
}

export function fingerprintCustomer(p) {
  return sha1(JSON.stringify(summarizeCustomer(p)));
}

export function classifyCustomer(topic, p, prevSummary) {
  if (topic === "CUSTOMERS_CREATE") return "created";
  if (topic === "CUSTOMERS_DELETE") return "deleted";

  const sinceCreate = secondsBetween(p?.created_at, p?.updated_at);
  if (sinceCreate !== null && Math.abs(sinceCreate) <= 60) return "created";

  const now = summarizeCustomer(p);
  if (!prevSummary || prevSummary.orders_count === undefined) {
    // First sighting: nothing to diff against. An update with no visible
    // reason is most likely a metafield write (Omneo), but we can't prove it.
    return "other";
  }

  const changed = Object.keys(now).filter((k) => now[k] !== prevSummary[k]);
  if (!changed.length) return "silent";
  if (changed.includes("orders_count") || changed.includes("total_spent")) {
    return "order_placed";
  }
  if (
    changed.some((k) => ["email_hash", "phone_hash", "addresses"].includes(k))
  ) {
    return "contact_change";
  }
  if (changed.every((k) => k === "tags")) return "tags";
  return "other";
}

// ---------------------------------------------------------------------------
// Fulfillments, fulfillment events, inventory
// ---------------------------------------------------------------------------

export function summarizeFulfillment(p) {
  return {
    status: p?.status ?? null,
    shipment_status: p?.shipment_status ?? null,
    tracking_company: p?.tracking_company ?? null,
    tracking_numbers: (p?.tracking_numbers ?? []).length,
  };
}

export function summarizeFulfillmentEvent(p) {
  return {
    status: p?.status ?? null,
    fulfillment_id: p?.fulfillment_id ?? null,
    order_id: p?.order_id ?? null,
  };
}

export function summarizeInventory(p) {
  return {
    inventory_item_id: p?.inventory_item_id ?? null,
    location_id: p?.location_id ?? null,
    available: p?.available ?? null,
  };
}

export function classifyInventory(p, prevSummary) {
  const now = Number(p?.available);
  if (Number.isNaN(now)) return "other";
  if (now === 0) return "zero";
  const prev = prevSummary ? Number(prevSummary.available) : NaN;
  if (Number.isNaN(prev)) return "other";
  if (now < prev) return "decrement";
  if (now > prev) return "increment";
  return "same";
}

// ---------------------------------------------------------------------------
// Products, inventory items, refunds
// ---------------------------------------------------------------------------

// Products: the catalogue fields a backend syncs. Stock counts are hashed
// separately so a stock-only bump can be told apart from a real edit.
export function summarizeProduct(p) {
  const variants = Array.isArray(p?.variants) ? p.variants : [];
  const catalogue = variants
    .map((v) => `${v?.id}:${v?.sku ?? ""}:${v?.price ?? ""}:${v?.compare_at_price ?? ""}`)
    .join("|");
  const stock = variants.map((v) => `${v?.id}:${v?.inventory_quantity ?? ""}`).join("|");
  return {
    status: p?.status ?? null,
    tags: tagList(p?.tags).sort().join(","),
    variants: variants.length,
    catalogue_hash: sha1(catalogue),
    stock_hash: sha1(stock),
    title_hash: p?.title ? sha1(p.title) : "",
    body_hash: p?.body_html ? sha1(p.body_html) : "",
    images: Array.isArray(p?.images) ? p.images.length : 0,
  };
}

export function classifyProduct(topic, p, prevSummary) {
  if (topic === "PRODUCTS_CREATE") return "created";
  if (topic === "PRODUCTS_DELETE") return "deleted";
  const now = summarizeProduct(p);
  if (!prevSummary || prevSummary.catalogue_hash === undefined) return "other";
  const changed = Object.keys(now).filter((k) => now[k] !== prevSummary[k]);
  if (!changed.length) return "silent";
  if (changed.every((k) => k === "stock_hash")) return "stock_only";
  if (changed.includes("status")) return "status";
  if (changed.includes("catalogue_hash") || changed.includes("variants")) {
    return "variants_or_price";
  }
  if (changed.every((k) => k === "tags")) return "tags";
  return "content";
}

export function summarizeInventoryItem(p) {
  return {
    sku_hash: p?.sku ? sha1(p.sku) : "",
    tracked: p?.tracked ?? null,
    cost: p?.cost ?? null,
    requires_shipping: p?.requires_shipping ?? null,
  };
}

export function classifyInventoryItem(p, prevSummary) {
  const now = summarizeInventoryItem(p);
  if (!prevSummary || prevSummary.sku_hash === undefined) return "other";
  const changed = Object.keys(now).filter((k) => now[k] !== prevSummary[k]);
  if (!changed.length) return "silent";
  if (changed.every((k) => k === "cost")) return "cost";
  return "changed";
}

// Returns: payload carries `order.admin_graphql_api_id` (a gid) rather than a
// numeric order_id on most topics; handle both.
function numericIdFromGid(gid) {
  const m = String(gid ?? "").match(/\/(\d+)$/);
  return m ? m[1] : null;
}

export function summarizeReturn(p) {
  const lines = Array.isArray(p?.return_line_items) ? p.return_line_items : [];
  return {
    status: p?.status ?? null,
    line_items: lines.length,
    quantity: lines.reduce((sum, l) => sum + (Number(l?.quantity) || 0), 0),
  };
}

export function returnOrderId(p) {
  if (p?.order_id) return String(p.order_id);
  return numericIdFromGid(p?.order?.admin_graphql_api_id ?? p?.order?.id);
}

export function summarizeDraftOrder(p) {
  const lines = Array.isArray(p?.line_items) ? p.line_items : [];
  return {
    status: p?.status ?? null,
    order_id: p?.order_id ?? null,
    line_items: lines.length,
    total_price: p?.total_price ?? null,
    tags: tagList(p?.tags).sort().join(","),
    invoice_sent: Boolean(p?.invoice_sent_at),
  };
}

export function classifyDraftOrder(topic, p, prevSummary) {
  if (topic === "DRAFT_ORDERS_CREATE") return "created";
  if (topic === "DRAFT_ORDERS_DELETE") return "deleted";
  const now = summarizeDraftOrder(p);
  if (now.status === "completed" || now.order_id) return "completed";
  if (!prevSummary || prevSummary.line_items === undefined) return "other";
  const changed = Object.keys(now).filter((k) => now[k] !== prevSummary[k]);
  if (!changed.length) return "silent";
  if (changed.includes("invoice_sent")) return "invoice_sent";
  if (changed.includes("line_items") || changed.includes("total_price")) {
    return "items_changed";
  }
  if (changed.every((k) => k === "tags")) return "tags";
  return "other";
}

export function summarizeRefund(p) {
  const lines = Array.isArray(p?.refund_line_items) ? p.refund_line_items : [];
  const transactions = Array.isArray(p?.transactions) ? p.transactions : [];
  return {
    order_id: p?.order_id ?? null,
    line_items: lines.length,
    restock: lines.some((l) => l?.restock_type && l.restock_type !== "no_restock"),
    amount: transactions
      .reduce((sum, t) => sum + (Number(t?.amount) || 0), 0)
      .toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Source guess
// ---------------------------------------------------------------------------

export function guessSource(resourceType, p) {
  const tags = tagList(p?.tags).map((t) => t.toLowerCase());
  if (tags.includes("cx-manual-import")) return "omneo";
  if (tags.some((t) => t.startsWith("kibo") || t.startsWith("oms-"))) return "kibo";
  if (tags.includes("pos-order") || p?.source_name === "pos") return "pos";
  if (tags.some((t) => t.includes("youpay")) || p?.source_name === "youpay") {
    return "youpay";
  }
  if (resourceType === "fulfillment") {
    const company = String(p?.tracking_company ?? "").toLowerCase();
    if (company.includes("australia post") || company.includes("auspost")) {
      return "auspost";
    }
  }
  if (resourceType === "order" && p?.source_name === "web") return "shopify";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Per-topic extraction: what to store for each payload shape
// ---------------------------------------------------------------------------

function describe(topic, p, prevSummary) {
  if (topic === "ORDERS_EDITED") {
    // Payload is { order_edit: { id, order_id, app_id, created_at, ... } }.
    const edit = p?.order_edit ?? p;
    const orderId = edit?.order_id ? String(edit.order_id) : null;
    const summary = { edit_id: edit?.id ?? null, app_id: edit?.app_id ?? null };
    return {
      resourceType: "order",
      resourceId: orderId ?? "",
      resourceName: orderId ? `order ${orderId}` : null,
      orderId,
      classification: "edited",
      summary,
      resourceUpdatedAt: toDate(edit?.created_at),
    };
  }
  if (topic === "REFUNDS_CREATE") {
    const summary = summarizeRefund(p);
    const orderId = p?.order_id ? String(p.order_id) : null;
    return {
      resourceType: "refund",
      resourceId: String(p?.id ?? ""),
      resourceName: orderId ? `order ${orderId}` : null,
      orderId,
      classification: summary.restock ? "refund_restock" : "refund",
      summary,
      resourceUpdatedAt: toDate(p?.created_at),
    };
  }
  if (topic.startsWith("RETURNS_")) {
    const summary = summarizeReturn(p);
    const orderId = returnOrderId(p);
    const action = topic.replace("RETURNS_", "").toLowerCase();
    return {
      resourceType: "return",
      resourceId: String(p?.id ?? numericIdFromGid(p?.admin_graphql_api_id) ?? ""),
      resourceName: p?.name ?? (orderId ? `order ${orderId}` : null),
      orderId,
      // e.g. request, approve, close. The return's own status is in summary.
      classification: action,
      summary,
      resourceUpdatedAt: toDate(p?.updated_at),
    };
  }
  if (topic.startsWith("DRAFT_ORDERS_")) {
    const summary = summarizeDraftOrder(p);
    return {
      resourceType: "draft_order",
      resourceId: String(p?.id ?? ""),
      resourceName: p?.name ?? null,
      orderId: p?.order_id ? String(p.order_id) : null,
      classification: classifyDraftOrder(topic, p, prevSummary),
      summary,
      resourceUpdatedAt: toDate(p?.updated_at),
    };
  }
  if (topic.startsWith("PRODUCTS_")) {
    const summary = summarizeProduct(p);
    return {
      resourceType: "product",
      resourceId: String(p?.id ?? ""),
      resourceName: p?.handle ?? null,
      classification: classifyProduct(topic, p, prevSummary),
      summary,
      resourceUpdatedAt: toDate(p?.updated_at),
    };
  }
  if (topic === "INVENTORY_ITEMS_UPDATE") {
    const summary = summarizeInventoryItem(p);
    return {
      resourceType: "inventory_item",
      resourceId: String(p?.id ?? ""),
      resourceName: null,
      classification: classifyInventoryItem(p, prevSummary),
      summary,
      resourceUpdatedAt: toDate(p?.updated_at),
    };
  }
  if (topic.startsWith("ORDERS_")) {
    const summary = summarizeOrder(p);
    return {
      resourceType: "order",
      resourceId: String(p?.id ?? ""),
      resourceName: p?.name ?? null,
      orderId: p?.id ? String(p.id) : null,
      classification: classifyOrder(topic, p, prevSummary),
      summary,
      resourceUpdatedAt: toDate(p?.updated_at),
    };
  }
  if (topic.startsWith("CUSTOMERS_")) {
    const summary = summarizeCustomer(p);
    return {
      resourceType: "customer",
      resourceId: String(p?.id ?? ""),
      resourceName: null,
      classification: classifyCustomer(topic, p, prevSummary),
      summary,
      resourceUpdatedAt: toDate(p?.updated_at),
    };
  }
  if (topic.startsWith("FULFILLMENTS_")) {
    const summary = summarizeFulfillment(p);
    return {
      resourceType: "fulfillment",
      resourceId: String(p?.id ?? ""),
      resourceName: p?.name ?? (p?.order_id ? `order ${p.order_id}` : null),
      orderId: p?.order_id ? String(p.order_id) : null,
      classification: summary.status || "other",
      summary,
      resourceUpdatedAt: toDate(p?.updated_at),
    };
  }
  if (topic === "FULFILLMENT_EVENTS_CREATE") {
    const summary = summarizeFulfillmentEvent(p);
    return {
      resourceType: "fulfillment_event",
      resourceId: String(p?.fulfillment_id ?? p?.id ?? ""),
      resourceName: p?.order_id ? `order ${p.order_id}` : null,
      orderId: p?.order_id ? String(p.order_id) : null,
      classification: summary.status || "other",
      summary,
      resourceUpdatedAt: toDate(p?.happened_at),
    };
  }
  if (topic === "INVENTORY_LEVELS_UPDATE") {
    const summary = summarizeInventory(p);
    return {
      resourceType: "inventory_level",
      resourceId: `${summary.inventory_item_id}:${summary.location_id}`,
      resourceName: null,
      classification: classifyInventory(p, prevSummary),
      summary,
      resourceUpdatedAt: toDate(p?.updated_at),
    };
  }
  return null;
}

// Resource id from the payload without a prior DB lookup, so the previous row
// can be fetched before classification.
function resourceKey(topic, p) {
  if (topic === "ORDERS_EDITED") {
    const edit = p?.order_edit ?? p;
    return { resourceType: "order", resourceId: String(edit?.order_id ?? "") };
  }
  if (topic === "REFUNDS_CREATE") {
    return { resourceType: "refund", resourceId: String(p?.id ?? "") };
  }
  if (topic.startsWith("PRODUCTS_")) {
    return { resourceType: "product", resourceId: String(p?.id ?? "") };
  }
  if (topic.startsWith("RETURNS_")) {
    return {
      resourceType: "return",
      resourceId: String(p?.id ?? numericIdFromGid(p?.admin_graphql_api_id) ?? ""),
    };
  }
  if (topic.startsWith("DRAFT_ORDERS_")) {
    return { resourceType: "draft_order", resourceId: String(p?.id ?? "") };
  }
  if (topic === "INVENTORY_ITEMS_UPDATE") {
    return { resourceType: "inventory_item", resourceId: String(p?.id ?? "") };
  }
  if (topic === "INVENTORY_LEVELS_UPDATE") {
    return {
      resourceType: "inventory_level",
      resourceId: `${p?.inventory_item_id}:${p?.location_id}`,
    };
  }
  if (topic === "FULFILLMENT_EVENTS_CREATE") {
    return {
      resourceType: "fulfillment_event",
      resourceId: String(p?.fulfillment_id ?? p?.id ?? ""),
    };
  }
  if (topic.startsWith("FULFILLMENTS_")) {
    return { resourceType: "fulfillment", resourceId: String(p?.id ?? "") };
  }
  if (topic.startsWith("CUSTOMERS_")) {
    return { resourceType: "customer", resourceId: String(p?.id ?? "") };
  }
  return { resourceType: "order", resourceId: String(p?.id ?? "") };
}

// ---------------------------------------------------------------------------
// Record one delivery. Called from the webhook handler; must stay cheap.
// ---------------------------------------------------------------------------

export function readWebhookHeaders(request) {
  const h = request.headers;
  return {
    webhookId: h.get("X-Shopify-Webhook-Id") || null,
    eventId: h.get("X-Shopify-Event-Id") || null,
    triggeredAt: toDate(h.get("X-Shopify-Triggered-At")),
    apiVersion: h.get("X-Shopify-Api-Version") || null,
  };
}

// Returns { recorded: true, row } or { recorded: false, reason }.
export async function recordWebhookEvent({
  shop,
  topic,
  payload,
  headers,
  payloadBytes,
}) {
  const p = payload && typeof payload === "object" ? payload : {};
  const { resourceType, resourceId } = resourceKey(topic, p);

  const prev = await prisma.webhookEvent.findFirst({
    where: { shop, resourceType, resourceId },
    orderBy: { receivedAt: "desc" },
    select: { fingerprint: true, summaryJson: true },
  });
  const prevSummary = prev ? parseSummary(prev) : null;

  const info = describe(topic, p, prevSummary);
  if (!info) return { recorded: false, reason: "unmonitored topic" };

  const fingerprint = sha1(JSON.stringify(info.summary));
  // Fall back to a hash of the delivery when Shopify sends no webhook id
  // (shouldn't happen, but a missing unique key must not 500 the handler).
  const webhookId =
    headers.webhookId ||
    sha1(`${shop}|${topic}|${info.resourceId}|${info.resourceUpdatedAt?.toISOString()}`);

  try {
    const row = await prisma.webhookEvent.create({
      data: {
        shop,
        topic,
        webhookId,
        eventId: headers.eventId,
        resourceType: info.resourceType,
        resourceId: info.resourceId,
        resourceName: info.resourceName,
        orderId: info.orderId ?? null,
        triggeredAt: headers.triggeredAt,
        resourceUpdatedAt: info.resourceUpdatedAt,
        classification: info.classification,
        fingerprint,
        repeatOfPrev: Boolean(prev && prev.fingerprint === fingerprint),
        payloadBytes: payloadBytes ?? 0,
        source: guessSource(info.resourceType, p),
        summaryJson: JSON.stringify(info.summary),
        apiVersion: headers.apiVersion,
      },
    });
    // Raw body alongside, compressed. Best effort: a failure here must not
    // lose the event row or make Shopify retry.
    try {
      const text = JSON.stringify(p);
      await prisma.webhookPayload.create({
        data: {
          webhookId,
          shop,
          receivedAt: row.receivedAt,
          bytes: Buffer.byteLength(text),
          body: gzipSync(text),
        },
      });
    } catch (err) {
      console.error("[webhook-monitor] payload store failed", err?.message);
    }
    return { recorded: true, row };
  } catch (err) {
    if (err?.code === "P2002") {
      return { recorded: false, reason: "duplicate delivery" };
    }
    throw err;
  }
}

// The stored raw body for one event, parsed. Null when pruned or never stored.
export async function readPayload({ shop, eventId }) {
  const event = await prisma.webhookEvent.findFirst({
    where: { id: eventId, shop },
    select: { webhookId: true, topic: true, receivedAt: true },
  });
  if (!event) return null;
  const stored = await prisma.webhookPayload.findUnique({
    where: { webhookId: event.webhookId },
  });
  if (!stored) return { event, payload: null };
  let payload = null;
  try {
    payload = JSON.parse(gunzipSync(stored.body).toString("utf8"));
  } catch (err) {
    console.error("[webhook-monitor] payload read failed", err?.message);
  }
  return { event, payload, bytes: stored.bytes };
}

// ---------------------------------------------------------------------------
// Queue depth samples from the legacy server
// ---------------------------------------------------------------------------

export async function recordQueueSample({ shop, files, oldestAge }) {
  return prisma.webhookQueueSample.create({
    data: {
      shop,
      files: Math.max(0, Math.trunc(Number(files) || 0)),
      oldestAge:
        oldestAge === null || oldestAge === undefined
          ? null
          : Math.max(0, Math.trunc(Number(oldestAge) || 0)),
    },
  });
}

// ---------------------------------------------------------------------------
// Rollup + prune. Run hourly (scripts/webhook-monitor-cron.mjs).
// ---------------------------------------------------------------------------

function floorHour(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

// Re-aggregates every completed hour in the last RAW_WINDOW_DAYS. Rows are
// stamped receivedAt = now on arrival, so older hours cannot change. Upsert
// makes it idempotent, so running it more often than hourly is harmless.
export async function rollupHours({ now = new Date() } = {}) {
  const currentHour = floorHour(now);
  const from = new Date(currentHour.getTime() - RAW_WINDOW_DAYS * 86400e3);

  const rows = await prisma.webhookEvent.findMany({
    where: { receivedAt: { gte: from, lt: currentHour } },
    select: {
      shop: true,
      topic: true,
      classification: true,
      receivedAt: true,
      repeatOfPrev: true,
    },
  });

  const buckets = new Map();
  for (const r of rows) {
    const hour = floorHour(r.receivedAt);
    const key = `${r.shop}|${r.topic}|${r.classification}|${hour.toISOString()}`;
    const b = buckets.get(key) || {
      shop: r.shop,
      topic: r.topic,
      classification: r.classification,
      hour,
      count: 0,
      repeats: 0,
    };
    b.count += 1;
    if (r.repeatOfPrev) b.repeats += 1;
    buckets.set(key, b);
  }

  let written = 0;
  for (const b of buckets.values()) {
    await prisma.webhookHourly.upsert({
      where: {
        shop_topic_classification_hour: {
          shop: b.shop,
          topic: b.topic,
          classification: b.classification,
          hour: b.hour,
        },
      },
      create: b,
      update: { count: b.count, repeats: b.repeats },
    });
    written += 1;
  }
  return { rawRows: rows.length, buckets: written };
}

export async function pruneOld({ now = new Date() } = {}) {
  const rawCutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 86400e3);
  const hourlyCutoff = new Date(now.getTime() - HOURLY_RETENTION_DAYS * 86400e3);
  const queueCutoff = new Date(
    now.getTime() - QUEUE_SAMPLE_RETENTION_DAYS * 86400e3,
  );
  const payloadCutoff = new Date(
    now.getTime() - PAYLOAD_RETENTION_DAYS * 86400e3,
  );
  const [raw, payloads, hourly, queue] = await Promise.all([
    prisma.webhookEvent.deleteMany({ where: { receivedAt: { lt: rawCutoff } } }),
    prisma.webhookPayload.deleteMany({
      where: { receivedAt: { lt: payloadCutoff } },
    }),
    prisma.webhookHourly.deleteMany({ where: { hour: { lt: hourlyCutoff } } }),
    prisma.webhookQueueSample.deleteMany({
      where: { sampledAt: { lt: queueCutoff } },
    }),
  ]);
  return {
    raw: raw.count,
    hourly: hourly.count,
    queue: queue.count,
    payloads: payloads.count,
  };
}

// ---------------------------------------------------------------------------
// Dashboard reads. DB only, no Admin API.
// ---------------------------------------------------------------------------

export const WINDOWS = {
  "15m": { minutes: 15, bucketMinutes: 1 },
  "1h": { minutes: 60, bucketMinutes: 1 },
  "6h": { minutes: 360, bucketMinutes: 5 },
  "12h": { minutes: 720, bucketMinutes: 10 },
  "24h": { minutes: 1440, bucketMinutes: 15 },
  "7d": { minutes: 10080, bucketMinutes: 60 },
  // Longer windows come from the hourly rollup (90 day retention), so bucket
  // sizes must be whole hours.
  "14d": { minutes: 20160, bucketMinutes: 240 },
  "30d": { minutes: 43200, bucketMinutes: 720 },
};

// Every shop that has ever sent a row, plus the known regions, plus whatever
// is installed (offline session). Sorted with known regions first.
export async function listMonitorShops() {
  const [sessions, events] = await Promise.all([
    prisma.session.findMany({
      where: { isOnline: false },
      select: { shop: true },
      distinct: ["shop"],
    }),
    prisma.webhookEvent.findMany({ select: { shop: true }, distinct: ["shop"] }),
  ]);
  const set = new Set([
    ...sessions.map((s) => s.shop),
    ...events.map((e) => e.shop),
  ]);
  const known = Object.keys(KNOWN_SHOPS).filter((s) => set.has(s));
  const rest = [...set].filter((s) => !KNOWN_SHOPS[s]).sort();
  return [...known, ...rest].map((shop) => ({ shop, label: shopLabel(shop) }));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bucketStart(date, bucketMinutes) {
  const ms = bucketMinutes * 60e3;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

// Everything the dashboard page shows, for one shop and one window.
export async function readDashboard({
  shop,
  window = "1h",
  topicFilter = "",
  classFilter = "",
  now = new Date(),
}) {
  const win = WINDOWS[window] || WINDOWS["1h"];
  const from = new Date(now.getTime() - win.minutes * 60e3);
  // Windows over RAW_WINDOW_DAYS take totals and the timeline from the hourly
  // rollup and only read the last RAW_WINDOW_DAYS of raw rows (current hour
  // counts, delivery lag, top resources), so a 30 day view never loads a
  // month of raw rows.
  const useHourly = win.minutes > RAW_WINDOW_DAYS * 1440;
  const rawFrom = useHourly
    ? new Date(now.getTime() - RAW_WINDOW_DAYS * 86400e3)
    : from;

  const raw = await prisma.webhookEvent.findMany({
    where: { shop, receivedAt: { gte: rawFrom } },
    select: {
      topic: true,
      classification: true,
      receivedAt: true,
      triggeredAt: true,
      repeatOfPrev: true,
      resourceType: true,
      resourceId: true,
      resourceName: true,
      orderId: true,
    },
    orderBy: { receivedAt: "asc" },
    take: 100000,
  });

  const hourly = useHourly
    ? await prisma.webhookHourly.findMany({
        where: { shop, hour: { gte: floorHour(from) } },
        orderBy: { hour: "asc" },
      })
    : [];

  // --- totals ---------------------------------------------------------------
  let events = 0;
  let noise = 0;
  const lags = [];
  const byTopicClass = new Map();
  const timeline = new Map();
  const topics = new Set();

  // Per-topic totals so the page can show stats for whichever topics are
  // selected in the timeline legend without another round trip. Lag samples
  // are kept as a 0.1s histogram per topic so a combined median across any
  // selection can be computed client-side from small data.
  const byTopic = new Map();
  const topicStats = (topic) => {
    let t = byTopic.get(topic);
    if (!t) {
      t = { topic, count: 0, noise: 0, repeats: 0, lagHist: {}, lagSamples: 0 };
      byTopic.set(topic, t);
    }
    return t;
  };

  const addCount = (topic, classification, count, repeats, at) => {
    events += count;
    const n = NOISE_CLASSES.has(classification) ? count : Math.min(repeats, count);
    noise += n;
    const ts = topicStats(topic);
    ts.count += count;
    ts.noise += n;
    ts.repeats += repeats;
    topics.add(topic);
    const key = `${topic}|${classification}`;
    const tc = byTopicClass.get(key) || {
      topic,
      classification,
      count: 0,
      repeats: 0,
    };
    tc.count += count;
    tc.repeats += repeats;
    byTopicClass.set(key, tc);
    const b = bucketStart(at, win.bucketMinutes).toISOString();
    const t = timeline.get(b) || {};
    t[topic] = (t[topic] || 0) + count;
    timeline.set(b, t);
  };

  if (useHourly) {
    // Hourly rollup for completed hours, raw rows for the current hour (the
    // rollup never includes the hour in progress).
    const currentHour = floorHour(now);
    for (const h of hourly) {
      if (h.hour >= currentHour) continue;
      addCount(h.topic, h.classification, h.count, h.repeats, h.hour);
    }
    for (const r of raw) {
      if (r.receivedAt < currentHour) continue;
      addCount(r.topic, r.classification, 1, r.repeatOfPrev ? 1 : 0, r.receivedAt);
    }
  } else {
    for (const r of raw) {
      addCount(r.topic, r.classification, 1, r.repeatOfPrev ? 1 : 0, r.receivedAt);
    }
  }
  for (const r of raw) {
    if (r.triggeredAt) {
      const lag = (r.receivedAt.getTime() - r.triggeredAt.getTime()) / 1000;
      lags.push(lag);
      const ts = topicStats(r.topic);
      // 0.1s bins, capped at 1 hour so the histogram stays small.
      const bin = Math.min(36000, Math.round(lag * 10));
      ts.lagHist[bin] = (ts.lagHist[bin] || 0) + 1;
      ts.lagSamples += 1;
    }
  }

  // Fill empty buckets so the chart shows gaps as gaps.
  const bucketMs = win.bucketMinutes * 60e3;
  const firstBucket = bucketStart(from, win.bucketMinutes);
  const lastBucket = bucketStart(now, win.bucketMinutes);
  const series = [];
  for (let t = firstBucket.getTime(); t <= lastBucket.getTime(); t += bucketMs) {
    const iso = new Date(t).toISOString();
    series.push({ at: iso, counts: timeline.get(iso) || {} });
  }

  // --- top repeated resources ---------------------------------------------
  const byResource = new Map();
  for (const r of raw) {
    const key = `${r.resourceType}|${r.resourceId}`;
    const x = byResource.get(key) || {
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      resourceName: r.resourceName,
      orderId: r.orderId,
      rows: 0,
      repeats: 0,
      topics: new Set(),
    };
    x.rows += 1;
    if (r.repeatOfPrev) x.repeats += 1;
    x.topics.add(r.topic);
    if (r.resourceName) x.resourceName = r.resourceName;
    byResource.set(key, x);
  }
  const topResources = [...byResource.values()]
    .filter((x) => x.rows > 1)
    .sort((a, b) => b.rows - a.rows || b.repeats - a.repeats)
    .slice(0, 20)
    .map((x) => ({ ...x, topics: [...x.topics].sort() }));

  // --- recent events (filterable) -----------------------------------------
  const recent = await prisma.webhookEvent.findMany({
    where: {
      shop,
      receivedAt: { gte: from },
      ...(topicFilter ? { topic: topicFilter } : {}),
      ...(classFilter ? { classification: classFilter } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: 100,
    select: {
      id: true,
      topic: true,
      classification: true,
      resourceType: true,
      resourceId: true,
      resourceName: true,
      orderId: true,
      receivedAt: true,
      triggeredAt: true,
      repeatOfPrev: true,
      source: true,
      payloadBytes: true,
      apiVersion: true,
    },
  });

  // --- legacy queue depth ---------------------------------------------------
  const queueSamples = await prisma.webhookQueueSample.findMany({
    where: { shop, sampledAt: { gte: from } },
    orderBy: { sampledAt: "asc" },
    select: { files: true, oldestAge: true, sampledAt: true },
    take: 10000,
  });
  let queue = null;
  if (queueSamples.length) {
    const latest = queueSamples[queueSamples.length - 1];
    const fifteenAgo = new Date(now.getTime() - 15 * 60e3);
    const recentSamples = queueSamples.filter((s) => s.sampledAt >= fifteenAgo);
    // "Rising for 15 minutes": every sample in the last 15 min >= the one
    // before it, and the last is above the first. Needs at least 3 samples.
    let rising = false;
    if (recentSamples.length >= 3) {
      rising =
        recentSamples.every((s, i) => i === 0 || s.files >= recentSamples[i - 1].files) &&
        recentSamples[recentSamples.length - 1].files > recentSamples[0].files;
    }
    queue = {
      current: latest.files,
      oldestAge: latest.oldestAge,
      sampledAt: latest.sampledAt,
      rising,
      stale: now.getTime() - latest.sampledAt.getTime() > 5 * 60e3,
      samples: queueSamples,
    };
  }

  const allClasses = [...new Set(raw.map((r) => r.classification))].sort();

  // Every monitored topic appears in the legend and filters even with zero
  // events in the window, so the set of options never shifts between loads.
  for (const t of MONITORED_TOPICS) {
    topics.add(t);
    topicStats(t);
  }
  const allTopics = [...topics].sort();

  return {
    shop,
    window,
    windowMinutes: win.minutes,
    from,
    now,
    usingHourly: useHourly,
    rawWindowDays: RAW_WINDOW_DAYS,
    rawRetentionDays: RAW_RETENTION_DAYS,
    truncated: raw.length >= 100000,
    totals: {
      events,
      perMinute: win.minutes ? events / win.minutes : 0,
      noise,
      noisePct: events ? (noise / events) * 100 : 0,
      medianLagSeconds: median(lags),
      lagSamples: lags.length,
    },
    timeline: { bucketMinutes: win.bucketMinutes, series, topics: allTopics },
    byTopic: [...byTopic.values()].sort(
      (a, b) => b.count - a.count || a.topic.localeCompare(b.topic),
    ),
    byTopicClass: [...byTopicClass.values()].sort((a, b) => b.count - a.count),
    topResources,
    recent,
    queue,
    filters: { topics: allTopics, classes: allClasses },
  };
}

// ---------------------------------------------------------------------------
// Bucket drill-down: every raw row inside one timeline bar, with the stored
// summary and what moved since the previous message for the same resource.
// Raw rows only, so buckets older than RAW_RETENTION_DAYS come back empty.
// ---------------------------------------------------------------------------

export const BUCKET_ROW_CAP = 1000;

// Human-readable "a -> b" for one summary key.
function describeChange(key, before, after) {
  const fmt = (v) => {
    if (v === null || v === undefined || v === "") return "none";
    if (key === "tags")
      return String(v).split(",").filter(Boolean).join(", ") || "none";
    return String(v);
  };
  return `${key}: ${fmt(before)} -> ${fmt(after)}`;
}

export async function readBucketEvents({
  shop,
  at,
  bucketMinutes,
  topic = "",
  classification = "",
  resourceType = "",
  source = "",
  repeatsOnly = false,
  search = "",
}) {
  const start = toDate(at);
  const minutes = Number(bucketMinutes);
  if (!start || !minutes || Number.isNaN(minutes)) {
    return { events: [], total: 0, capped: false, options: {} };
  }
  const end = new Date(start.getTime() + minutes * 60e3);

  const q = String(search || "").trim();
  const where = {
    shop,
    receivedAt: { gte: start, lt: end },
    ...(topic ? { topic } : {}),
    ...(classification ? { classification } : {}),
    ...(resourceType ? { resourceType } : {}),
    ...(source ? { source } : {}),
    ...(repeatsOnly ? { repeatOfPrev: true } : {}),
    ...(q
      ? {
          OR: [
            { resourceName: { contains: q } },
            { resourceId: { contains: q } },
            { orderId: { contains: q } },
          ],
        }
      : {}),
  };
  // Filter options come from the whole bucket (topic applied, nothing else)
  // so narrowing one filter never empties the others.
  const optionRows = await prisma.webhookEvent.findMany({
    where: {
      shop,
      receivedAt: { gte: start, lt: end },
      ...(topic ? { topic } : {}),
    },
    select: { classification: true, resourceType: true, source: true },
    distinct: ["classification", "resourceType", "source"],
    take: 5000,
  });
  const options = {
    classes: [...new Set(optionRows.map((r) => r.classification))].sort(),
    resourceTypes: [...new Set(optionRows.map((r) => r.resourceType))].sort(),
    sources: [...new Set(optionRows.map((r) => r.source).filter(Boolean))].sort(),
  };

  const [total, rows] = await Promise.all([
    prisma.webhookEvent.count({ where }),
    prisma.webhookEvent.findMany({
      where,
      orderBy: { receivedAt: "asc" },
      take: BUCKET_ROW_CAP,
      select: {
        id: true,
        topic: true,
        classification: true,
        resourceType: true,
        resourceId: true,
        resourceName: true,
        orderId: true,
        receivedAt: true,
        triggeredAt: true,
        resourceUpdatedAt: true,
        repeatOfPrev: true,
        source: true,
        payloadBytes: true,
        apiVersion: true,
        summaryJson: true,
        webhookId: true,
      },
    }),
  ]);

  // Which of these still have a stored raw body (3 day retention).
  const withPayload = new Set(
    (
      await prisma.webhookPayload.findMany({
        where: { webhookId: { in: rows.map((r) => r.webhookId) } },
        select: { webhookId: true },
      })
    ).map((p) => p.webhookId),
  );

  // Previous summary per resource: the latest row before the bucket for each
  // resource seen in it, then walk the bucket in order so later rows diff
  // against earlier ones in the same bucket.
  const keys = new Map();
  for (const r of rows) {
    keys.set(`${r.resourceType}|${r.resourceId}`, {
      resourceType: r.resourceType,
      resourceId: r.resourceId,
    });
  }
  const prevByKey = new Map();
  const keyList = [...keys.values()];
  for (let i = 0; i < keyList.length; i += 200) {
    const chunk = keyList.slice(i, i + 200);
    const prevRows = await prisma.webhookEvent.findMany({
      where: { shop, receivedAt: { lt: start }, OR: chunk },
      orderBy: { receivedAt: "desc" },
      distinct: ["resourceType", "resourceId"],
      select: {
        resourceType: true,
        resourceId: true,
        receivedAt: true,
        summaryJson: true,
      },
    });
    for (const p of prevRows) {
      prevByKey.set(`${p.resourceType}|${p.resourceId}`, {
        receivedAt: p.receivedAt,
        summary: parseSummary(p),
      });
    }
  }

  const events = rows.map((r) => {
    const key = `${r.resourceType}|${r.resourceId}`;
    const summary = parseSummary(r);
    const prev = prevByKey.get(key) || null;
    const changes = prev
      ? Object.keys(summary)
          .filter((k) => summary[k] !== prev.summary[k])
          .map((k) => describeChange(k, prev.summary[k], summary[k]))
      : [];
    prevByKey.set(key, { receivedAt: r.receivedAt, summary });
    const { summaryJson, webhookId, ...rest } = r;
    return {
      ...rest,
      summary,
      previousAt: prev ? prev.receivedAt : null,
      firstSeen: !prev,
      changes,
      hasPayload: withPayload.has(webhookId),
    };
  });

  return { events, total, capped: total > rows.length, start, end, options };
}
