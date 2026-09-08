import { json } from "@remix-run/node";
import { useLoaderData, useRevalidator, useSearchParams } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
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
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
];

// One colour per topic on the timeline. Order matters: the first topics listed
// get the most distinguishable colours.
const TOPIC_COLOURS = {
  ORDERS_UPDATED: "#2C6ECB",
  ORDERS_CREATE: "#008060",
  ORDERS_CANCELLED: "#D72C0D",
  CUSTOMERS_UPDATE: "#E3A008",
  CUSTOMERS_CREATE: "#B98900",
  FULFILLMENTS_CREATE: "#8E44AD",
  FULFILLMENTS_UPDATE: "#C084FC",
  FULFILLMENT_EVENTS_CREATE: "#5C6AC4",
  INVENTORY_LEVELS_UPDATE: "#6D7175",
};
const FALLBACK_COLOURS = ["#00A0AC", "#F49342", "#9C6ADE", "#47C1BF", "#DE3618"];

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
  other: undefined,
};

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shops = await listMonitorShops();

  const requested = url.searchParams.get("shop");
  const shop =
    requested && shops.some((s) => s.shop === requested) ? requested : session.shop;
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
  return topic.toLowerCase().replace(/_/g, "/").replace("fulfillment/events", "fulfillment_events").replace("inventory/levels", "inventory_levels");
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
  return null;
}

function colourFor(topic, index) {
  return TOPIC_COLOURS[topic] || FALLBACK_COLOURS[index % FALLBACK_COLOURS.length];
}

// ---------------------------------------------------------------------------
// Charts (inline SVG, no extra bundle)
// ---------------------------------------------------------------------------

function StackedTimeline({ timeline, windowKey }) {
  const { series, topics, bucketMinutes } = timeline;
  const width = 960;
  const height = 220;
  const padL = 44;
  const padB = 28;
  const padT = 8;
  const plotW = width - padL - 8;
  const plotH = height - padB - padT;

  const max = Math.max(
    1,
    ...series.map((b) => Object.values(b.counts).reduce((a, c) => a + c, 0)),
  );
  const barW = plotW / Math.max(1, series.length);
  const yTicks = 4;
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  const withDate = windowKey === "7d" || windowKey === "24h";

  if (!series.some((b) => Object.keys(b.counts).length)) {
    return (
      <Box paddingBlock="600">
        <Text as="p" tone="subdued" alignment="center">
          No events in this window.
        </Text>
      </Box>
    );
  }

  return (
    <BlockStack gap="300">
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
                <line x1={padL} x2={width - 8} y1={y} y2={y} stroke="#E3E3E3" strokeWidth="1" />
                <text x={padL - 6} y={y + 4} fontSize="11" fill="#6D7175" textAnchor="end">
                  {v}
                </text>
              </g>
            );
          })}
          {series.map((b, i) => {
            let yCursor = padT + plotH;
            const total = Object.values(b.counts).reduce((a, c) => a + c, 0);
            const x = padL + i * barW;
            return (
              <g key={b.at}>
                <title>
                  {`${fmtTime(b.at, true)} (${bucketMinutes} min): ${total} event(s)\n` +
                    topics
                      .filter((t) => b.counts[t])
                      .map((t) => `${topicSlug(t)}: ${b.counts[t]}`)
                      .join("\n")}
                </title>
                {topics.map((t, ti) => {
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
                      fill={colourFor(t, ti)}
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
      <InlineStack gap="300" wrap>
        {topics.map((t, ti) => (
          <InlineStack key={t} gap="100" blockAlign="center">
            <span
              style={{
                display: "inline-block",
                width: 12,
                height: 12,
                borderRadius: 2,
                background: colourFor(t, ti),
              }}
            />
            <Text as="span" variant="bodySm">
              {topicSlug(t)}
            </Text>
          </InlineStack>
        ))}
      </InlineStack>
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
              <text x={padL - 6} y={y + 4} fontSize="11" fill="#6D7175" textAnchor="end">
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
        <text x={width - 8} y={height - 6} fontSize="11" fill="#6D7175" textAnchor="end">
          {fmtTime(samples[samples.length - 1].sampledAt, true)}
        </text>
      </svg>
    </div>
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

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, revalidator]);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true, preventScrollReset: true });
  };

  const shopOptions = data.shops.map((s) => ({ label: s.label, value: s.shop }));
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
        data.totals.events ? `${((r.count / data.totals.events) * 100).toFixed(1)}%` : "0%",
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
      fmtTime(e.receivedAt, data.window === "7d" || data.window === "24h"),
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
              Windows over 3 days use the hourly rollup for totals and the
              timeline. Delivery lag, top resources and recent events only cover
              the last 3 days of raw rows.
            </Text>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Totals for the window
            </Text>
            <InlineStack gap="800" wrap>
              <BigNumber label="Events" value={fmtInt(data.totals.events)} />
              <BigNumber
                label="Events / min"
                value={data.totals.perMinute.toFixed(data.totals.perMinute < 10 ? 2 : 1)}
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
            <StackedTimeline timeline={data.timeline} windowKey={data.window} />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              By topic and classification
            </Text>
            {topicClassRows.length ? (
              <DataTable
                columnContentTypes={["text", "text", "numeric", "numeric", "numeric"]}
                headings={["Topic", "Classification", "Count", "% of total", "Repeats"]}
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
              Resources with the most deliveries in the window. Repeats are rows
              whose fingerprint matched the previous row for that resource, so
              nothing a backend cares about changed.
            </Text>
            {resourceRows.length ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric", "numeric"]}
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

        <Card>
          <BlockStack gap="300">
            <InlineStack gap="300" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Legacy queue depth
              </Text>
              {queue?.rising && <Badge tone="critical">Rising for 15 min</Badge>}
              {queue?.stale && <Badge tone="warning">Feed stale</Badge>}
            </InlineStack>
            {queue ? (
              <BlockStack gap="300">
                <InlineStack gap="800" wrap>
                  <BigNumber label="Files queued now" value={fmtInt(queue.current)} />
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
                No samples for this store in the window. The legacy server
                needs the one-line cron from WEBHOOK_MONITOR_HANDOFF.md posting
                to /api/webhook-monitor/queue-depth.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Recent events
            </Text>
            <InlineStack gap="300" blockAlign="end" wrap>
              <Box minWidth="220px">
                <Select
                  label="Topic"
                  options={[
                    { label: "All topics", value: "" },
                    ...data.filters.topics.map((t) => ({ label: topicSlug(t), value: t })),
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
                    ...data.filters.classes.map((c) => ({ label: c, value: c })),
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
