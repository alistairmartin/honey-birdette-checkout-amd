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

// Raw rows live this long; hourly rollups keep the 7 to 30 day views working.
export const RAW_RETENTION_DAYS = 3;
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
    return { recorded: true, row };
  } catch (err) {
    if (err?.code === "P2002") {
      return { recorded: false, reason: "duplicate delivery" };
    }
    throw err;
  }
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

// Re-aggregates every completed hour still covered by raw rows. Upsert makes
// it idempotent, so running it more often than hourly is harmless.
export async function rollupHours({ now = new Date() } = {}) {
  const currentHour = floorHour(now);
  const from = new Date(currentHour.getTime() - RAW_RETENTION_DAYS * 86400e3);

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
  const [raw, hourly, queue] = await Promise.all([
    prisma.webhookEvent.deleteMany({ where: { receivedAt: { lt: rawCutoff } } }),
    prisma.webhookHourly.deleteMany({ where: { hour: { lt: hourlyCutoff } } }),
    prisma.webhookQueueSample.deleteMany({
      where: { sampledAt: { lt: queueCutoff } },
    }),
  ]);
  return { raw: raw.count, hourly: hourly.count, queue: queue.count };
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
  // Raw rows only cover RAW_RETENTION_DAYS; longer windows lean on the rollup.
  const useHourly = win.minutes > RAW_RETENTION_DAYS * 1440;

  const raw = await prisma.webhookEvent.findMany({
    where: { shop, receivedAt: { gte: from } },
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

  const addCount = (topic, classification, count, repeats, at) => {
    events += count;
    noise += NOISE_CLASSES.has(classification)
      ? count
      : Math.min(repeats, count);
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
      lags.push((r.receivedAt.getTime() - r.triggeredAt.getTime()) / 1000);
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

  return {
    shop,
    window,
    from,
    now,
    usingHourly: useHourly,
    truncated: raw.length >= 100000,
    totals: {
      events,
      perMinute: win.minutes ? events / win.minutes : 0,
      noise,
      noisePct: events ? (noise / events) * 100 : 0,
      medianLagSeconds: median(lags),
      lagSamples: lags.length,
    },
    timeline: { bucketMinutes: win.bucketMinutes, series, topics: [...topics].sort() },
    byTopicClass: [...byTopicClass.values()].sort((a, b) => b.count - a.count),
    topResources,
    recent,
    queue,
    filters: { topics: [...topics].sort(), classes: allClasses },
  };
}
