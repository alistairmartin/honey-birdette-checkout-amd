import { json } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "@remix-run/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Banner,
  Badge,
  Box,
  Select,
  DataTable,
  Link as PolarisLink,
  Checkbox,
  Divider,
  Modal,
  Button,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  WINDOWS,
  listMonitorShops,
  readDashboard,
  shopLabel,
} from "../lib/webhookMonitor.server";

// Live view of what Shopify is emitting to this app per store, per topic, per
// minute, and which of it is noise. Observation only: see
// WEBHOOK_MONITOR_HANDOFF.md for the incident that motivated it and the
// classification rules (app/lib/webhookMonitor.server.js).

const WINDOW_OPTIONS = [
  { label: "Last 15 minutes", value: "15m" },
  { label: "Last hour", value: "1h" },
  { label: "Last 6 hours", value: "6h" },
  { label: "Last 12 hours", value: "12h" },
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 14 days", value: "14d" },
  { label: "Last 30 days", value: "30d" },
];
// Windows long enough that a bare clock time is ambiguous.
const DATED_WINDOWS = new Set(["12h", "24h", "7d", "14d", "30d"]);

// One hue per resource type, shades within it. The legend groups topics by
// type (LEGEND_GROUPS), so a stacked bar reads "blue block is orders" at a
// glance and the tooltip resolves which order topic. Shades step from dark
// to light in legend (alphabetical) order.
const GROUP_HUES = {
  ORDERS: 218, // blue
  REFUNDS: 4, // red
  RETURNS: 28, // orange
  DRAFT_ORDERS: 210, // slate (low saturation, see below)
  FULFILLMENT: 275, // purple
  CUSTOMERS: 42, // gold
  PRODUCTS: 178, // teal
  INVENTORY: 0, // grey (zero saturation)
};
const GROUP_SATURATION = { DRAFT_ORDERS: 18, INVENTORY: 0 };

function groupKey(topic) {
  if (topic.startsWith("DRAFT_ORDERS_")) return "DRAFT_ORDERS";
  if (topic.startsWith("FULFILLMENT")) return "FULFILLMENT";
  return topic.split("_")[0];
}

// Build the palette once from a sorted topic list so shades are stable.
function buildPalette(topics) {
  const byGroup = new Map();
  for (const t of [...topics].sort()) {
    const g = groupKey(t);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(t);
  }
  const palette = {};
  for (const [g, list] of byGroup) {
    const hue = GROUP_HUES[g] ?? 300;
    const sat = GROUP_SATURATION[g] ?? 62;
    const n = list.length;
    list.forEach((t, i) => {
      // Lightness from 30% (dark) to 72% (light); a single topic sits mid.
      const l = n === 1 ? 48 : 30 + (42 * i) / (n - 1);
      palette[t] = `hsl(${hue} ${sat}% ${l.toFixed(0)}%)`;
    });
  }
  return palette;
}

const PALETTE = buildPalette([
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_PAID",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
  "ORDERS_EDITED",
  "ORDERS_DELETE",
  "REFUNDS_CREATE",
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
  "CUSTOMERS_DELETE",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "INVENTORY_LEVELS_UPDATE",
  "INVENTORY_ITEMS_UPDATE",
]);
const FALLBACK_COLOURS = [
  "hsl(300 50% 40%)",
  "hsl(300 50% 55%)",
  "hsl(300 50% 70%)",
];

// Legend rows, one per resource type, in this order.
const LEGEND_GROUPS = [
  { label: "Orders", match: (t) => t.startsWith("ORDERS_") },
  { label: "Refunds", match: (t) => t.startsWith("REFUNDS_") },
  { label: "Returns", match: (t) => t.startsWith("RETURNS_") },
  { label: "Draft orders", match: (t) => t.startsWith("DRAFT_ORDERS_") },
  { label: "Fulfillments", match: (t) => t.startsWith("FULFILLMENT") },
  { label: "Customers", match: (t) => t.startsWith("CUSTOMERS_") },
  { label: "Products", match: (t) => t.startsWith("PRODUCTS_") },
  { label: "Inventory", match: (t) => t.startsWith("INVENTORY_") },
  {
    label: "Other",
    match: (t) =>
      !/^(ORDERS|REFUNDS|RETURNS|DRAFT_ORDERS|FULFILLMENT|CUSTOMERS|PRODUCTS|INVENTORY)/.test(t),
  },
];

const CLASS_TONE = {
  new_order: "success",
  created: "success",
  order_placed: "success",
  cancelled: "critical",
  refund: "warning",
  fulfilled: "info",
  tracking_only: "attention",
  silent: "attention",
  tag_or_note: undefined,
  tags: undefined,
  contact_change: "info",
  decrement: "info",
  increment: "info",
  zero: "warning",
  same: "attention",
  paid: "success",
  partially_fulfilled: "info",
  edited: "warning",
  deleted: "critical",
  refund_restock: "warning",
  stock_only: "attention",
  status: "info",
  variants_or_price: "info",
  content: undefined,
  cost: undefined,
  changed: "info",
  request: "warning",
  approve: "info",
  decline: "critical",
  cancel: "critical",
  close: "success",
  reopen: "warning",
  update: undefined,
  completed: "success",
  invoice_sent: "info",
  items_changed: "info",
  other: undefined,
};

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shops = await listMonitorShops();

  const requested = url.searchParams.get("shop");
  const shop =
    requested && shops.some((s) => s.shop === requested)
      ? requested
      : session.shop;
  if (!shops.some((s) => s.shop === shop)) {
    shops.unshift({ shop, label: shopLabel(shop) });
  }

  const window = WINDOWS[url.searchParams.get("window")]
    ? url.searchParams.get("window")
    : "1h";

  const data = await readDashboard({
    shop,
    window,
    topicFilter: url.searchParams.get("topic") || "",
    classFilter: url.searchParams.get("class") || "",
  });

  return json({
    embeddedShop: session.shop,
    shops,
    ...data,
    secretConfigured: Boolean(process.env.WEBHOOK_MONITOR_SECRET),
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtInt(n) {
  return new Intl.NumberFormat("en-AU").format(Math.round(n || 0));
}

function fmtSeconds(s) {
  if (s === null || s === undefined || Number.isNaN(s)) return "n/a";
  const abs = Math.abs(s);
  if (abs < 60) return `${s.toFixed(1)}s`;
  if (abs < 3600) return `${(s / 60).toFixed(1)}m`;
  if (abs < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function fmtTime(iso, withDate = false) {
  const d = new Date(iso);
  const opts = {
    hour: "2-digit",
    minute: "2-digit",
    second: withDate ? undefined : "2-digit",
    hour12: false,
    ...(withDate ? { day: "2-digit", month: "short" } : {}),
  };
  return d.toLocaleString("en-AU", opts);
}

function topicSlug(topic) {
  return topic
    .toLowerCase()
    .replace(/_/g, "/")
    .replace("fulfillment/events", "fulfillment_events")
    .replace("inventory/levels", "inventory_levels")
    .replace("inventory/items", "inventory_items")
    .replace("partially/fulfilled", "partially_fulfilled")
    .replace("draft/orders", "draft_orders");
}

function adminUrl(shop, resourceType, resourceId, orderId) {
  const handle = shop.replace(".myshopify.com", "");
  if (orderId) {
    return `https://admin.shopify.com/store/${handle}/orders/${orderId}`;
  }
  if (resourceType === "order") {
    return `https://admin.shopify.com/store/${handle}/orders/${resourceId}`;
  }
  if (resourceType === "customer") {
    return `https://admin.shopify.com/store/${handle}/customers/${resourceId}`;
  }
  if (resourceType === "product") {
    return `https://admin.shopify.com/store/${handle}/products/${resourceId}`;
  }
  if (resourceType === "draft_order") {
    return `https://admin.shopify.com/store/${handle}/draft_orders/${resourceId}`;
  }
  return null;
}

function colourFor(topic, index) {
  return PALETTE[topic] || FALLBACK_COLOURS[index % FALLBACK_COLOURS.length];
}

// ---------------------------------------------------------------------------
// Charts (inline SVG, no extra bundle)
// ---------------------------------------------------------------------------

function StackedTimeline({
  timeline,
  windowKey,
  hidden,
  toggleTopic,
  showAll,
  selectedAt,
  onSelect,
}) {
  const { series, topics, bucketMinutes } = timeline;
  const width = 960;
  const height = 220;
  const padL = 44;
  const padB = 28;
  const padT = 8;
  const plotW = width - padL - 8;
  const plotH = height - padB - padT;

  // Which bar the popover is for, plus where to anchor it (pixel coords
  // inside the chart wrapper).
  const [hover, setHover] = useState(null);

  const visibleTopics = topics.filter((t) => !hidden.has(t));
  const totalOf = (b) =>
    visibleTopics.reduce((a, t) => a + (b.counts[t] || 0), 0);

  const max = Math.max(1, ...series.map(totalOf));
  const barW = plotW / Math.max(1, series.length);
  const yTicks = 4;
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  const withDate = DATED_WINDOWS.has(windowKey);

  if (!series.some((b) => Object.keys(b.counts).length)) {
    return (
      <Box paddingBlock="600">
        <Text as="p" tone="subdued" alignment="center">
          No events in this window.
        </Text>
      </Box>
    );
  }

  const onBarEnter = (i) => (evt) => {
    const wrap = evt.currentTarget.closest("[data-chart-wrap]");
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const br = evt.currentTarget.getBoundingClientRect();
    setHover({
      index: i,
      x: br.left - wr.left + br.width / 2,
      flip: br.left - wr.left > wr.width * 0.6,
    });
  };

  const hovered = hover ? series[hover.index] : null;

  return (
    <BlockStack gap="300">
      {/* Outer wrapper is the popover's positioning context; the inner div
          scrolls. overflow-x:auto also clips vertically, so the popover must
          live outside it. */}
      <div
        data-chart-wrap
        style={{ position: "relative" }}
        onMouseLeave={() => setHover(null)}
      >
        <div style={{ overflowX: "auto" }}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            style={{ minWidth: 640, display: "block" }}
            role="img"
            aria-label="Events per bucket, stacked by topic"
          >
            {Array.from({ length: yTicks + 1 }).map((_, i) => {
              const v = Math.round((max / yTicks) * i);
              const y = padT + plotH - (plotH * v) / max;
              return (
                <g key={i}>
                  <line
                    x1={padL}
                    x2={width - 8}
                    y1={y}
                    y2={y}
                    stroke="#E3E3E3"
                    strokeWidth="1"
                  />
                  <text
                    x={padL - 6}
                    y={y + 4}
                    fontSize="11"
                    fill="#6D7175"
                    textAnchor="end"
                  >
                    {v}
                  </text>
                </g>
              );
            })}
            {series.map((b, i) => {
              let yCursor = padT + plotH;
              const x = padL + i * barW;
              const active = hover && hover.index === i;
              const selected = selectedAt === b.at;
              return (
                <g
                  key={b.at}
                  onMouseEnter={onBarEnter(i)}
                  onClick={() => onSelect(b.at, "")}
                  style={{ cursor: "pointer" }}
                >
                  {/* Full-height hit area so thin or empty bars are hoverable */}
                  <rect
                    x={x}
                    y={padT}
                    width={Math.max(1, barW)}
                    height={plotH}
                    fill={
                      selected
                        ? "rgba(0,91,211,0.10)"
                        : active
                          ? "rgba(0,0,0,0.05)"
                          : "transparent"
                    }
                    stroke={selected ? "#005BD3" : "none"}
                    strokeWidth={selected ? 1.5 : 0}
                  />
                  {visibleTopics.map((t) => {
                    const c = b.counts[t] || 0;
                    if (!c) return null;
                    const h = (plotH * c) / max;
                    yCursor -= h;
                    return (
                      <rect
                        key={t}
                        x={x + 0.5}
                        y={yCursor}
                        width={Math.max(1, barW - 1)}
                        height={h}
                        fill={colourFor(t, topics.indexOf(t))}
                        opacity={hover && !active ? 0.7 : 1}
                        onClick={(evt) => {
                          evt.stopPropagation();
                          onSelect(b.at, t);
                        }}
                      />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text
                      x={x + barW / 2}
                      y={height - 8}
                      fontSize="11"
                      fill="#6D7175"
                      textAnchor="middle"
                    >
                      {fmtTime(b.at, withDate).replace(/:\d\d$/, "")}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
        {hovered && (
          <div
            role="dialog"
            aria-label="Bucket detail"
            style={{
              position: "absolute",
              top: 4,
              left: hover.x,
              transform: hover.flip
                ? "translateX(calc(-100% - 12px))"
                : "translateX(12px)",
              zIndex: 20,
              pointerEvents: "none",
              minWidth: 200,
              maxWidth: 280,
              background: "var(--p-color-bg-surface, #fff)",
              color: "var(--p-color-text, #303030)",
              border: "1px solid var(--p-color-border, #E3E3E3)",
              borderRadius: 8,
              boxShadow: "var(--p-shadow-300, 0 4px 12px rgba(0,0,0,0.15))",
              padding: "10px 12px",
            }}
          >
            <BlockStack gap="150">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                {fmtTime(hovered.at, true)} ({bucketMinutes} min)
              </Text>
              <BlockStack gap="050">
                {visibleTopics
                  .filter((t) => hovered.counts[t])
                  .map((t) => (
                    <InlineStack
                      key={t}
                      gap="200"
                      align="space-between"
                      blockAlign="center"
                      wrap={false}
                    >
                      <InlineStack gap="100" blockAlign="center" wrap={false}>
                        <span
                          style={{
                            display: "inline-block",
                            width: 10,
                            height: 10,
                            borderRadius: 2,
                            background: colourFor(t, topics.indexOf(t)),
                            flex: "0 0 auto",
                          }}
                        />
                        <Text as="span" variant="bodySm">
                          {topicSlug(t)}
                        </Text>
                      </InlineStack>
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        {fmtInt(hovered.counts[t])}
                      </Text>
                    </InlineStack>
                  ))}
              </BlockStack>
              <Divider />
              <InlineStack gap="200" align="space-between">
                <Text as="span" variant="bodySm" tone="subdued">
                  Total
                </Text>
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {fmtInt(totalOf(hovered))}
                </Text>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Click to list every message in this bar.
              </Text>
            </BlockStack>
          </div>
        )}
      </div>
      <BlockStack gap="150">
        {LEGEND_GROUPS.map(({ label, match }) => {
          const group = topics.filter(match);
          if (!group.length) return null;
          return (
            <InlineStack key={label} gap="200" wrap blockAlign="center">
              <span style={{ minWidth: 96, display: "inline-block" }}>
                <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">
                  {label}
                </Text>
              </span>
              {group.map((t) => {
                const off = hidden.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTopic(t)}
                    aria-pressed={!off}
                    title={off ? "Show in timeline" : "Hide from timeline"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 8px",
                      border: "1px solid transparent",
                      borderRadius: 999,
                      background: off
                        ? "transparent"
                        : "var(--p-color-bg-surface-secondary, #F1F1F1)",
                      cursor: "pointer",
                      opacity: off ? 0.45 : 1,
                      font: "inherit",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        width: 12,
                        height: 12,
                        borderRadius: 2,
                        background: colourFor(t, topics.indexOf(t)),
                      }}
                    />
                    <Text
                      as="span"
                      variant="bodySm"
                      textDecorationLine={off ? "line-through" : undefined}
                    >
                      {topicSlug(t)}
                    </Text>
                  </button>
                );
              })}
            </InlineStack>
          );
        })}
        {hidden.size > 0 && (
          <InlineStack>
            <button
              type="button"
              onClick={showAll}
              style={{
                border: "none",
                background: "none",
                cursor: "pointer",
                padding: "2px 4px",
                font: "inherit",
              }}
            >
              <Text as="span" variant="bodySm" tone="subdued">
                Show all
              </Text>
            </button>
          </InlineStack>
        )}
      </BlockStack>
    </BlockStack>
  );
}

function QueueLine({ samples }) {
  const width = 960;
  const height = 160;
  const padL = 48;
  const padB = 24;
  const padT = 8;
  const plotW = width - padL - 8;
  const plotH = height - padB - padT;
  const max = Math.max(1, ...samples.map((s) => s.files));
  const t0 = new Date(samples[0].sampledAt).getTime();
  const t1 = new Date(samples[samples.length - 1].sampledAt).getTime();
  const span = Math.max(1, t1 - t0);
  const pts = samples.map((s) => {
    const x = padL + ((new Date(s.sampledAt).getTime() - t0) / span) * plotW;
    const y = padT + plotH - (s.files / max) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ minWidth: 640, display: "block" }}
        role="img"
        aria-label="Legacy queue depth over time"
      >
        {[0, 0.5, 1].map((f) => {
          const y = padT + plotH - plotH * f;
          return (
            <g key={f}>
              <line x1={padL} x2={width - 8} y1={y} y2={y} stroke="#E3E3E3" />
              <text
                x={padL - 6}
                y={y + 4}
                fontSize="11"
                fill="#6D7175"
                textAnchor="end"
              >
                {fmtInt(max * f)}
              </text>
            </g>
          );
        })}
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke="#D72C0D"
          strokeWidth="2"
        />
        <text x={padL} y={height - 6} fontSize="11" fill="#6D7175">
          {fmtTime(samples[0].sampledAt, true)}
        </text>
        <text
          x={width - 8}
          y={height - 6}
          fontSize="11"
          fill="#6D7175"
          textAnchor="end"
        >
          {fmtTime(samples[samples.length - 1].sampledAt, true)}
        </text>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bucket detail: every message inside one clicked timeline bar, with the
// resource it was about, a link to it in admin, and what moved in the tracked
// fields since the previous message for that resource. Raw rows only, so bars
// older than the raw retention (30 days) come back empty.
// ---------------------------------------------------------------------------

const SUMMARY_LABELS = {
  financial_status: "Payment",
  fulfillment_status: "Fulfilment",
  closed_at: "Closed",
  cancelled_at: "Cancelled",
  tags: "Tags",
  note_hash: "Note (hash)",
  refunds: "Refunds",
  fulfillments: "Shipments",
  total_price: "Total",
  orders_count: "Orders",
  total_spent: "Spent",
  state: "Account",
  addresses: "Addresses",
  email_hash: "Email (hash)",
  phone_hash: "Phone (hash)",
  email_consent: "Email consent",
  sms_consent: "SMS consent",
  status: "Status",
  shipment_status: "Shipment",
  tracking_company: "Carrier",
  tracking_numbers: "Tracking numbers",
  fulfillment_id: "Fulfilment id",
  order_id: "Order id",
  inventory_item_id: "Inventory item",
  location_id: "Location",
  available: "Available",
};

function fmtSummaryValue(key, v) {
  if (v === null || v === undefined || v === "") return "none";
  if (key === "tags") {
    return String(v).split(",").filter(Boolean).join(", ") || "none";
  }
  return String(v);
}

function SummaryDetails({ event }) {
  const entries = Object.entries(event.summary || {});
  if (!entries.length) return null;
  return (
    <details>
      <summary style={{ cursor: "pointer" }}>
        <Text as="span" variant="bodySm" tone="subdued">
          Data ({fmtInt(event.payloadBytes)} bytes)
        </Text>
      </summary>
      <div style={{ paddingTop: 4 }}>
        {entries.map(([k, v]) => (
          <div key={k} style={{ overflowWrap: "anywhere" }}>
            <Text as="span" variant="bodySm" tone="subdued">
              {SUMMARY_LABELS[k] || k}:{" "}
            </Text>
            <Text as="span" variant="bodySm">
              {fmtSummaryValue(k, v)}
            </Text>
          </div>
        ))}
      </div>
    </details>
  );
}

// Resource cell for inventory rows: product / variant name linked to the
// variant page, plus the location name, when the bucket route resolved them.
function InventoryResource({ shop, event, refs }) {
  const handle = shop.replace(".myshopify.com", "");
  const [itemId, locationId] =
    event.resourceType === "inventory_level"
      ? String(event.resourceId).split(":")
      : [String(event.resourceId), null];
  const item = refs?.inventoryItems?.[itemId];
  const location = locationId ? refs?.locations?.[locationId] : null;
  if (!item) {
    return (
      <span>
        <Text as="span" variant="bodySm" tone="subdued">
          {event.resourceType.replace(/_/g, " ")}{" "}
        </Text>
        {event.resourceId}
        {locationId && location ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {" "}
            at {location}
          </Text>
        ) : null}
      </span>
    );
  }
  const href =
    item.productId && item.variantId
      ? `https://admin.shopify.com/store/${handle}/products/${item.productId}/variants/${item.variantId}`
      : item.productId
        ? `https://admin.shopify.com/store/${handle}/products/${item.productId}`
        : null;
  const label = item.displayName || item.productTitle || itemId;
  return (
    <BlockStack gap="0">
      <span>
        {href ? (
          <PolarisLink url={href} target="_blank" removeUnderline>
            {label}
          </PolarisLink>
        ) : (
          label
        )}
      </span>
      <Text as="span" variant="bodySm" tone="subdued">
        {[item.sku ? `SKU ${item.sku}` : null, location ? `at ${location}` : null]
          .filter(Boolean)
          .join(" · ") || `item ${itemId}`}
      </Text>
    </BlockStack>
  );
}

const EMPTY_FILTERS = {
  topic: "",
  class: "",
  type: "",
  source: "",
  repeats: false,
  q: "",
};

function PayloadModal({ fetcher, onClose }) {
  const data = fetcher.data;
  const loading = fetcher.state !== "idle";
  const text = data?.payload ? JSON.stringify(data.payload, null, 2) : "";
  const title = data?.event
    ? `${topicSlug(data.event.topic)} received ${fmtTime(data.event.receivedAt, true)}`
    : "Raw message";
  return (
    <Modal
      open
      onClose={onClose}
      size="large"
      title={title}
      secondaryActions={[{ content: "Close", onAction: onClose }]}
    >
      <Modal.Section>
        {loading ? (
          <Text as="p" tone="subdued">
            Loading…
          </Text>
        ) : text ? (
          <BlockStack gap="200">
            <Text as="p" variant="bodySm" tone="subdued">
              The body exactly as Shopify sent it ({fmtInt(data.bytes)} bytes).
              Raw bodies are kept for 3 days.
            </Text>
            <pre
              style={{
                margin: 0,
                padding: 12,
                maxHeight: "70vh",
                overflow: "auto",
                fontSize: 12,
                lineHeight: 1.45,
                background: "var(--p-color-bg-surface-secondary, #F7F7F7)",
                borderRadius: 8,
                whiteSpace: "pre",
              }}
            >
              {text}
            </pre>
          </BlockStack>
        ) : (
          <Text as="p" tone="subdued">
            No raw body stored for this message. Bodies are kept for 3 days,
            and only for messages received after this feature was deployed.
          </Text>
        )}
      </Modal.Section>
    </Modal>
  );
}

function BucketDetail({
  shop,
  windowKey,
  retentionDays,
  bucket,
  counts,
  topics,
  fetcher,
  onFilters,
  onClose,
}) {
  const data = fetcher.data;
  const loading = fetcher.state !== "idle";
  const withDate = DATED_WINDOWS.has(windowKey);
  const f = bucket.filters;

  // Keep the last loaded filter options while a reload is in flight so the
  // selects do not flicker empty.
  const [options, setOptions] = useState({
    classes: [],
    resourceTypes: [],
    sources: [],
  });
  useEffect(() => {
    if (data?.options) setOptions(data.options);
  }, [data]);

  // Search applies after a short pause in typing.
  const [q, setQ] = useState(f.q);
  useEffect(() => {
    setQ(f.q);
  }, [f.q]);
  useEffect(() => {
    if (q === f.q) return undefined;
    const id = setTimeout(() => onFilters({ q }), 350);
    return () => clearTimeout(id);
  }, [q, f.q, onFilters]);

  const [rawId, setRawId] = useState(null);
  const rawFetcher = useFetcher();
  const openRaw = (id) => {
    setRawId(id);
    rawFetcher.load(
      `/app/webhook-monitor/payload?${new URLSearchParams({ shop, id })}`,
    );
  };

  const topicOptions = [
    { label: "All topics", value: "" },
    ...topics
      .filter((t) => counts[t])
      .map((t) => ({
        label: `${topicSlug(t)} (${fmtInt(counts[t])})`,
        value: t,
      })),
  ];
  const withAll = (label, values, current) => [
    { label, value: "" },
    ...values.map((v) => ({ label: v, value: v })),
    // Keep the current value selectable even if the options moved on.
    ...(current && !values.includes(current)
      ? [{ label: current, value: current }]
      : []),
  ];
  const activeCount = [f.class, f.type, f.source, f.q].filter(Boolean).length +
    (f.repeats ? 1 : 0);

  const rows = (data?.events || []).map((e) => {
    const href = adminUrl(shop, e.resourceType, e.resourceId, e.orderId);
    const label = e.resourceName || e.resourceId;
    const lag = e.triggeredAt
      ? (new Date(e.receivedAt) - new Date(e.triggeredAt)) / 1000
      : null;
    let changed;
    if (e.firstSeen) {
      changed = (
        <Text as="span" variant="bodySm" tone="subdued">
          first message seen for this {e.resourceType.replace(/_/g, " ")}
        </Text>
      );
    } else if (!e.changes.length) {
      changed = (
        <Text as="span" variant="bodySm" tone="subdued">
          nothing in the tracked fields (last message{" "}
          {fmtTime(e.previousAt, withDate)})
        </Text>
      );
    } else {
      changed = (
        <BlockStack gap="0">
          {e.changes.map((c) => (
            <Text key={c} as="span" variant="bodySm">
              {c}
            </Text>
          ))}
        </BlockStack>
      );
    }
    return [
      fmtTime(e.receivedAt, withDate),
      topicSlug(e.topic),
      <Badge key="c" tone={CLASS_TONE[e.classification]}>
        {e.classification}
      </Badge>,
      <BlockStack key="r" gap="0">
        {e.resourceType === "inventory_level" ||
        e.resourceType === "inventory_item" ? (
          <InventoryResource shop={shop} event={e} refs={data?.refs} />
        ) : (
          <span>
            <Text as="span" variant="bodySm" tone="subdued">
              {e.resourceType.replace(/_/g, " ")}{" "}
            </Text>
            {href ? (
              <PolarisLink url={href} target="_blank" removeUnderline>
                {label}
              </PolarisLink>
            ) : (
              label
            )}
          </span>
        )}
        <SummaryDetails event={e} />
      </BlockStack>,
      changed,
      e.repeatOfPrev ? "yes" : "",
      e.source || "",
      fmtSeconds(lag),
      e.hasPayload ? (
        <Button
          key="raw"
          variant="plain"
          size="slim"
          onClick={() => openRaw(e.id)}
        >
          Raw
        </Button>
      ) : (
        ""
      ),
    ];
  });

  const countBadge = loading ? (
    <Badge>loading</Badge>
  ) : data ? (
    <Badge tone={data.capped ? "warning" : undefined}>
      {data.capped
        ? `showing ${fmtInt(data.events.length)} of ${fmtInt(data.total)}`
        : `${fmtInt(data.total)} messages`}
    </Badge>
  ) : null;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="large"
        title={`Messages in bar ${fmtTime(bucket.at, true)}`}
        secondaryActions={[{ content: "Close", onAction: onClose }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <InlineStack gap="300" blockAlign="end" wrap>
              <Box minWidth="240px">
                <Select
                  label="Topic"
                  options={topicOptions}
                  value={f.topic}
                  onChange={(v) =>
                    onFilters({ topic: v, class: "", type: "", source: "" })
                  }
                />
              </Box>
              <Box minWidth="180px">
                <Select
                  label="Class"
                  options={withAll("All classes", options.classes, f.class)}
                  value={f.class}
                  onChange={(v) => onFilters({ class: v })}
                />
              </Box>
              <Box minWidth="180px">
                <Select
                  label="Type"
                  options={withAll("All types", options.resourceTypes, f.type)}
                  value={f.type}
                  onChange={(v) => onFilters({ type: v })}
                />
              </Box>
              <Box minWidth="160px">
                <Select
                  label="Source"
                  options={withAll("All sources", options.sources, f.source)}
                  value={f.source}
                  onChange={(v) => onFilters({ source: v })}
                />
              </Box>
              <Box minWidth="220px">
                <TextField
                  label="Resource"
                  labelHidden={false}
                  placeholder="#AU1072284 or an id"
                  value={q}
                  onChange={setQ}
                  clearButton
                  onClearButtonClick={() => setQ("")}
                  autoComplete="off"
                />
              </Box>
              <Checkbox
                label="Repeats only"
                checked={f.repeats}
                onChange={(v) => onFilters({ repeats: v })}
              />
              {activeCount > 0 && (
                <Button
                  variant="plain"
                  onClick={() => onFilters({ ...EMPTY_FILTERS, topic: f.topic })}
                >
                  Clear filters
                </Button>
              )}
              {countBadge}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Every message Shopify sent in this slice, oldest first. Resource
              links to admin. What changed compares the tracked fields
              (statuses, tags, counts, hashed contact fields) against the
              previous message for the same resource; nothing changed usually
              means a metafield or loyalty write. Open Data for the tracked
              fields, or Raw for the full message as received (kept 3 days).
            </Text>
          </BlockStack>
        </Modal.Section>
        <Modal.Section flush>
          {rows.length ? (
            <DataTable
              columnContentTypes={[
                "text",
                "text",
                "text",
                "text",
                "text",
                "text",
                "text",
                "numeric",
                "text",
              ]}
              headings={[
                "Received",
                "Topic",
                "Class",
                "Resource",
                "What changed",
                "Repeat",
                "Source",
                "Lag",
                "",
              ]}
              rows={rows}
              increasedTableDensity
              stickyHeader
            />
          ) : (
            <Box padding="400">
              <Text as="p" tone="subdued">
                {loading
                  ? "Loading…"
                  : activeCount > 0
                    ? "No messages match these filters."
                    : `No raw rows for this bar. Raw rows are kept for ${retentionDays} days; older bars only have hourly totals.`}
              </Text>
            </Box>
          )}
        </Modal.Section>
      </Modal>
      {rawId && (
        <PayloadModal fetcher={rawFetcher} onClose={() => setRawId(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Selected topics card: totals for whichever topics are switched on in the
// timeline legend, combined and per topic.
// ---------------------------------------------------------------------------

// Median from merged 0.1s histograms ({bin: count}).
function medianFromHists(hists) {
  const merged = new Map();
  let total = 0;
  for (const h of hists) {
    for (const [bin, c] of Object.entries(h)) {
      merged.set(Number(bin), (merged.get(Number(bin)) || 0) + c);
      total += c;
    }
  }
  if (!total) return { median: null, samples: 0 };
  const bins = [...merged.keys()].sort((a, b) => a - b);
  const half = total / 2;
  let seen = 0;
  for (const bin of bins) {
    seen += merged.get(bin);
    if (seen >= half) return { median: bin / 10, samples: total };
  }
  return { median: bins[bins.length - 1] / 10, samples: total };
}

function SelectedTopics({ byTopic, hidden, windowMinutes, totalEvents }) {
  const selected = byTopic.filter((t) => !hidden.has(t.topic));
  const all = selected.length === byTopic.length;

  const events = selected.reduce((a, t) => a + t.count, 0);
  const noise = selected.reduce((a, t) => a + t.noise, 0);
  const repeats = selected.reduce((a, t) => a + t.repeats, 0);
  const lag = medianFromHists(selected.map((t) => t.lagHist));

  const rows = selected.map((t) => {
    const l = medianFromHists([t.lagHist]);
    return [
      <InlineStack key="t" gap="100" blockAlign="center" wrap={false}>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: 2,
            background: colourFor(t.topic, byTopic.indexOf(t)),
          }}
        />
        <span>{topicSlug(t.topic)}</span>
      </InlineStack>,
      fmtInt(t.count),
      totalEvents ? `${((t.count / totalEvents) * 100).toFixed(1)}%` : "0%",
      windowMinutes ? (t.count / windowMinutes).toFixed(2) : "0",
      `${t.count ? ((t.noise / t.count) * 100).toFixed(0) : 0}%`,
      fmtInt(t.repeats),
      fmtSeconds(l.median),
    ];
  });

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Selected topics
          </Text>
          <Badge tone={all ? undefined : "info"}>
            {all
              ? `All ${byTopic.length} topics`
              : `${selected.length} of ${byTopic.length} topics`}
          </Badge>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          The same numbers as the totals card, but only for the topics switched
          on in the timeline legend above. Click legend colours to change the
          selection. Share of window is against every message in the window.
        </Text>
        {selected.length ? (
          <>
            <InlineStack gap="800" wrap>
              <BigNumber
                label="Events"
                value={fmtInt(events)}
                hint={
                  totalEvents
                    ? `${((events / totalEvents) * 100).toFixed(0)}% of window`
                    : undefined
                }
              />
              <BigNumber
                label="Events / min"
                value={
                  windowMinutes
                    ? (events / windowMinutes).toFixed(events / windowMinutes < 10 ? 2 : 1)
                    : "0"
                }
              />
              <BigNumber
                label="Flagged noise"
                value={`${events ? ((noise / events) * 100).toFixed(0) : 0}%`}
                hint={`${fmtInt(noise)} tracking-only, silent or repeat`}
              />
              <BigNumber
                label="Repeats"
                value={fmtInt(repeats)}
                hint="identical to the previous message"
              />
              <BigNumber
                label="Median delivery lag"
                value={fmtSeconds(lag.median)}
                hint={lag.samples ? `${fmtInt(lag.samples)} samples` : "no samples"}
              />
            </InlineStack>
            <DataTable
              columnContentTypes={[
                "text",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
              ]}
              headings={[
                "Topic",
                "Events",
                "Share of window",
                "Per min",
                "Noise",
                "Repeats",
                "Median lag",
              ]}
              rows={rows}
              increasedTableDensity
            />
          </>
        ) : (
          <Text as="p" tone="subdued">
            Every topic is hidden. Click a colour in the legend to select one.
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function BigNumber({ label, value, hint }) {
  return (
    <Box minWidth="160px">
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="heading2xl">
          {value}
        </Text>
        {hint && (
          <Text as="p" variant="bodySm" tone="subdued">
            {hint}
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}

export default function WebhookMonitor() {
  const data = useLoaderData();
  const [params, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const [autoRefresh, setAutoRefresh] = useState(true);
  // Legend doubles as a filter: click a topic to hide it from the timeline
  // and from the "Selected topics" card. Remembered for the tab, not the URL.
  const [hidden, setHidden] = useState(() => new Set());
  // Clicked timeline bar: { at, topic }. Loaded on demand via the bucket
  // resource route so the page loader stays light.
  const [bucket, setBucket] = useState(null);
  const bucketFetcher = useFetcher();
  const loadBucket = (at, filters) => {
    const q = new URLSearchParams({
      shop: data.shop,
      at,
      minutes: String(data.timeline.bucketMinutes),
    });
    if (filters.topic) q.set("topic", filters.topic);
    if (filters.class) q.set("class", filters.class);
    if (filters.type) q.set("type", filters.type);
    if (filters.source) q.set("source", filters.source);
    if (filters.repeats) q.set("repeats", "1");
    if (filters.q) q.set("q", filters.q);
    bucketFetcher.load(`/app/webhook-monitor/bucket?${q}`);
  };
  const selectBucket = (at, topic) => {
    const filters = { ...EMPTY_FILTERS, topic };
    setBucket({ at, filters });
    loadBucket(at, filters);
  };
  const updateBucketFilters = useCallback(
    (patch) => {
      setBucket((prev) => {
        if (!prev) return prev;
        const filters = { ...prev.filters, ...patch };
        loadBucket(prev.at, filters);
        return { ...prev, filters };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.shop, data.timeline.bucketMinutes],
  );
  const toggleTopic = (t) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, revalidator]);

  useEffect(() => {
    setBucket(null);
  }, [data.shop, data.window]);

  // Every time on the page is formatted in the viewer's browser zone. Say
  // which one, after hydration so server and client markup agree.
  const [tzLabel, setTzLabel] = useState("");
  useEffect(() => {
    try {
      const parts = new Intl.DateTimeFormat("en-AU", {
        timeZoneName: "short",
      }).formatToParts(new Date());
      const name = parts.find((x) => x.type === "timeZoneName")?.value;
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setTzLabel(name ? `${name} (${zone})` : zone);
    } catch {
      setTzLabel("");
    }
  }, []);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true, preventScrollReset: true });
  };

  const shopOptions = data.shops.map((s) => ({
    label: s.label,
    value: s.shop,
  }));
  const topicFilter = params.get("topic") || "";
  const classFilter = params.get("class") || "";

  const topicClassRows = useMemo(
    () =>
      data.byTopicClass.map((r) => [
        topicSlug(r.topic),
        <Badge key="c" tone={CLASS_TONE[r.classification]}>
          {r.classification}
        </Badge>,
        fmtInt(r.count),
        data.totals.events
          ? `${((r.count / data.totals.events) * 100).toFixed(1)}%`
          : "0%",
        fmtInt(r.repeats),
      ]),
    [data.byTopicClass, data.totals.events],
  );

  const resourceRows = data.topResources.map((r) => {
    const href = adminUrl(data.shop, r.resourceType, r.resourceId, r.orderId);
    const label = r.resourceName || r.resourceId;
    return [
      r.resourceType,
      href ? (
        <PolarisLink key="l" url={href} target="_blank" removeUnderline>
          {label}
        </PolarisLink>
      ) : (
        label
      ),
      r.topics.map(topicSlug).join(", "),
      fmtInt(r.rows),
      fmtInt(r.repeats),
    ];
  });

  const recentRows = data.recent.map((e) => {
    const href = adminUrl(data.shop, e.resourceType, e.resourceId, e.orderId);
    const label = e.resourceName || e.resourceId;
    const lag = e.triggeredAt
      ? (new Date(e.receivedAt) - new Date(e.triggeredAt)) / 1000
      : null;
    return [
      fmtTime(e.receivedAt, DATED_WINDOWS.has(data.window)),
      topicSlug(e.topic),
      <Badge key="c" tone={CLASS_TONE[e.classification]}>
        {e.classification}
      </Badge>,
      href ? (
        <PolarisLink key="l" url={href} target="_blank" removeUnderline>
          {label}
        </PolarisLink>
      ) : (
        label
      ),
      e.repeatOfPrev ? "yes" : "",
      e.source || "",
      fmtSeconds(lag),
      e.apiVersion || "",
    ];
  });

  const queue = data.queue;

  return (
    <Page fullWidth>
      <TitleBar title="Webhook monitor" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              What Shopify is sending this app for the selected store, and how
              much of it is noise. Observation only: this shows what Shopify
              emits, not whether the legacy backend processed it (the queue
              depth card below covers that when the feed is on).
            </Text>
            <InlineStack gap="300" blockAlign="end" wrap>
              <Box minWidth="280px">
                <Select
                  label="Store"
                  options={shopOptions}
                  value={data.shop}
                  onChange={(v) => setParam("shop", v)}
                />
              </Box>
              <Box minWidth="200px">
                <Select
                  label="Window"
                  options={WINDOW_OPTIONS}
                  value={data.window}
                  onChange={(v) => setParam("window", v)}
                />
              </Box>
              <Checkbox
                label="Auto-refresh every 30s"
                checked={autoRefresh}
                onChange={setAutoRefresh}
              />
              <Text as="span" variant="bodySm" tone="subdued">
                Updated {fmtTime(data.now)}
                {revalidator.state !== "idle" ? " (refreshing)" : ""}
                {tzLabel ? `. Times shown in ${tzLabel}, your browser's zone` : ""}
              </Text>
            </InlineStack>
          </BlockStack>
        </Card>

        {!data.secretConfigured && (
          <Banner tone="warning" title="WEBHOOK_MONITOR_SECRET is not set">
            <Text as="p">
              The hourly rollup and prune cron and the queue-depth feed will be
              rejected until the secret is set on the Render web service and the
              webhook-monitor-maintenance cron. Raw rows will keep growing.
            </Text>
          </Banner>
        )}

        {data.usingHourly && (
          <Banner tone="info">
            <Text as="p">
              Windows over {data.rawWindowDays} days take totals and the
              timeline from the hourly rollup. Delivery lag and top resources
              cover the last {data.rawWindowDays} days only. Recent events and
              the bar drill-down cover the whole window ({data.rawRetentionDays}{" "}
              days of raw rows are kept).
            </Text>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Totals for the window
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Every time something changes on an order, customer, shipment or
              stock level, Shopify sends this app a message (a webhook). Events
              is how many arrived. Flagged noise is the share the backend did
              not need: messages about an order that was already shipped, paid
              and closed (a courier scan), customer updates where nothing
              visible changed (a loyalty balance write), or a message that
              repeated the previous one word for word. Delivery lag is how long
              a message took to reach us after Shopify sent it.
            </Text>
            <InlineStack gap="800" wrap>
              <BigNumber label="Events" value={fmtInt(data.totals.events)} />
              <BigNumber
                label="Events / min"
                value={data.totals.perMinute.toFixed(
                  data.totals.perMinute < 10 ? 2 : 1,
                )}
              />
              <BigNumber
                label="Flagged noise"
                value={`${data.totals.noisePct.toFixed(0)}%`}
                hint={`${fmtInt(data.totals.noise)} tracking-only, silent or repeat`}
              />
              <BigNumber
                label="Median delivery lag"
                value={fmtSeconds(data.totals.medianLagSeconds)}
                hint={
                  data.totals.lagSamples
                    ? `received minus triggered, ${fmtInt(data.totals.lagSamples)} samples`
                    : "no X-Shopify-Triggered-At seen yet"
                }
              />
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Timeline ({data.timeline.bucketMinutes} minute buckets)
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              How many messages arrived in each slice of time, coloured by
              type. Tall spikes are bursts, such as a courier posting a batch
              of tracking scans or a stock sync. Click a colour in the legend
              to hide that type; hover a bar for the breakdown; click a bar
              (or one colour in it) to list every message it contains.
            </Text>
            <StackedTimeline
              timeline={data.timeline}
              windowKey={data.window}
              hidden={hidden}
              toggleTopic={toggleTopic}
              showAll={() => setHidden(new Set())}
              selectedAt={bucket?.at || null}
              onSelect={selectBucket}
            />
          </BlockStack>
        </Card>

        {bucket && (
          <BucketDetail
            shop={data.shop}
            windowKey={data.window}
            retentionDays={data.rawRetentionDays}
            bucket={bucket}
            counts={
              data.timeline.series.find((b) => b.at === bucket.at)?.counts ||
              {}
            }
            topics={data.timeline.topics}
            fetcher={bucketFetcher}
            onFilters={updateBucketFilters}
            onClose={() => setBucket(null)}
          />
        )}

        <SelectedTopics
          byTopic={data.byTopic}
          hidden={hidden}
          windowMinutes={data.windowMinutes}
          totalEvents={data.totals.events}
        />

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              By topic and classification
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Topic is the kind of message Shopify sent. Classification is our
              reading of why it was sent (new order, tracking only, refund,
              silent, and so on). Count is how many. Repeats is how many of
              those carried no new data at all: the order, customer or
              shipment was in exactly the same state as the last message we
              received about it (same payment status, same fulfilment status,
              same tags, same tracking, same totals). Shopify sent it again
              because something it does not include in the message changed,
              usually a courier scan or a metafield write. The backend would
              have been correct to ignore every one of them, so a high Repeats
              number is the first place to cut.
            </Text>
            {topicClassRows.length ? (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "numeric",
                  "numeric",
                  "numeric",
                ]}
                headings={[
                  "Topic",
                  "Classification",
                  "Count",
                  "% of total",
                  "Repeats",
                ]}
                rows={topicClassRows}
                increasedTableDensity
              />
            ) : (
              <Text as="p" tone="subdued">
                Nothing recorded yet for this store and window.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Top repeated resources
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              The orders, customers and shipments Shopify sent the most messages
              about. Rows is how many messages arrived. Repeats is how many of
              them said exactly the same thing as the message before, so the
              backend learned nothing new from them (usually a courier scan
              re-sending an order that was already shipped and closed).
            </Text>
            {resourceRows.length ? (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "numeric",
                ]}
                headings={["Type", "Resource", "Topics", "Rows", "Repeats"]}
                rows={resourceRows}
                increasedTableDensity
              />
            ) : (
              <Text as="p" tone="subdued">
                No resource fired more than once in this window.
              </Text>
            )}
          </BlockStack>
        </Card>

        {queue && (
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="300" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Legacy queue depth
                </Text>
                {queue?.rising && (
                  <Badge tone="critical">Rising for 15 min</Badge>
                )}
                {queue?.stale && <Badge tone="warning">Feed stale</Badge>}
              </InlineStack>
              {queue ? (
                <BlockStack gap="300">
                  <InlineStack gap="800" wrap>
                    <BigNumber
                      label="Files queued now"
                      value={fmtInt(queue.current)}
                    />
                    <BigNumber
                      label="Oldest file age"
                      value={fmtSeconds(queue.oldestAge)}
                    />
                    <BigNumber
                      label="Last sample"
                      value={fmtTime(queue.sampledAt)}
                      hint={`${fmtInt(queue.samples.length)} samples in window`}
                    />
                  </InlineStack>
                  <QueueLine samples={queue.samples} />
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued">
                  No samples for this store in the window. The legacy server needs
                  the one-line cron from WEBHOOK_MONITOR_HANDOFF.md posting to
                  /api/webhook-monitor/queue-depth.
                </Text>
              )}
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Recent events
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              The last 100 messages, newest first. Repeat means it matched the
              message before it. Source is a best guess at what caused the
              change. Lag is delivery time from Shopify to this app.
            </Text>
            <InlineStack gap="300" blockAlign="end" wrap>
              <Box minWidth="220px">
                <Select
                  label="Topic"
                  options={[
                    { label: "All topics", value: "" },
                    ...data.filters.topics.map((t) => ({
                      label: topicSlug(t),
                      value: t,
                    })),
                  ]}
                  value={topicFilter}
                  onChange={(v) => setParam("topic", v)}
                />
              </Box>
              <Box minWidth="220px">
                <Select
                  label="Classification"
                  options={[
                    { label: "All classifications", value: "" },
                    ...data.filters.classes.map((c) => ({
                      label: c,
                      value: c,
                    })),
                  ]}
                  value={classFilter}
                  onChange={(v) => setParam("class", v)}
                />
              </Box>
            </InlineStack>
            <Divider />
            {recentRows.length ? (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "text",
                ]}
                headings={[
                  "Received",
                  "Topic",
                  "Class",
                  "Resource",
                  "Repeat",
                  "Source",
                  "Lag",
                  "API",
                ]}
                rows={recentRows}
                increasedTableDensity
              />
            ) : (
              <Text as="p" tone="subdued">
                No matching events.
              </Text>
            )}
            {data.truncated && (
              <Text as="p" variant="bodySm" tone="subdued">
                Window capped at 100,000 raw rows; totals may be low.
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
