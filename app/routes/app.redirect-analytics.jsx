import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Page,
  Card,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Banner,
  Box,
  Select,
  DataTable,
  ProgressBar,
  ButtonGroup,
  Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  scanBatch,
  listInstalledShops,
  adminForShop,
} from "../lib/redirectAnalytics.server";
import WorldChoropleth from "../components/WorldChoropleth";
import BarList from "../components/BarList";
import {
  canonicalStore,
  storeLabel,
  sourceIsoFor,
} from "../lib/redirectAnalytics.shared";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shops = await listInstalledShops();
  return json({ shop: session.shop, shops });
}

export async function action({ request }) {
  await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "scan") {
    return json({ error: "Unknown action" }, { status: 400 });
  }
  const shop = form.get("shop");
  const cursor = form.get("cursor") || null;
  const sinceISO = form.get("sinceISO") || null;
  try {
    const admin = await adminForShop(shop);
    const result = await scanBatch({ admin, cursor, sinceISO });
    return json({ intent: "scan", shop, ...result });
  } catch (err) {
    return json({
      intent: "scan",
      shop,
      scanned: 0,
      redirected: 0,
      byOrigin: {},
      byDetected: {},
      byCountry: {},
      flows: {},
      done: true,
      fatal: err?.message || String(err),
    });
  }
}

function countryName(code) {
  if (!code || code.startsWith("(")) return code;
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) || code;
  } catch {
    return code;
  }
}


const WINDOW_OPTIONS = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "Last 12 months", value: "365" },
  { label: "All time", value: "0" },
];

function mergeCounts(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    target[k] = (target[k] || 0) + v;
  }
}

function sortedEntries(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function pct(n, total) {
  if (!total) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

// Keep the browser-side drill-down sample bounded across all stores.
const CLIENT_SAMPLE_CAP = 2000;

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCSV(filename, headers, rows) {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function emptyAgg() {
  return {
    scanned: 0,
    redirected: 0,
    byOrigin: {},
    byDetected: {},
    byCountry: {},
    flows: {},
  };
}

export default function RedirectAnalytics() {
  const { shops } = useLoaderData();
  const fetcher = useFetcher();
  const lastData = useRef(null);

  const reachableShops = useMemo(
    () => shops.filter((s) => s.reachable),
    [shops],
  );

  const [windowDays, setWindowDays] = useState("30");
  const [mapOrigin, setMapOrigin] = useState("ALL"); // map filter: origin store
  const [running, setRunning] = useState(false);
  const [fatals, setFatals] = useState([]);
  const [hasRun, setHasRun] = useState(false);

  // Combined totals across every region, plus a per-store (destination) bucket
  // and an origin-store -> destination-store matrix.
  const [combined, setCombined] = useState(emptyAgg());
  const [perStore, setPerStore] = useState({}); // shop -> {scanned,redirected,byDetected}
  const [matrix, setMatrix] = useState({}); // "FROM>DEST" -> count
  const [orders, setOrders] = useState([]); // per-order drill-down sample
  const [sampleCapped, setSampleCapped] = useState(false);
  const [activeShop, setActiveShop] = useState(null);

  // The scan queue is driven imperatively so the effect can advance it without
  // re-subscribing. queueRef holds the remaining shops; idxRef the current one.
  const queueRef = useRef([]);
  const currentRef = useRef(null);
  const sinceISORef = useRef("");

  function computeSinceISO(days) {
    const n = Number(days);
    if (!n || n <= 0) return "";
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }

  function submitScan(shop, cursor) {
    fetcher.submit(
      { intent: "scan", shop, cursor, sinceISO: sinceISORef.current },
      { method: "post" },
    );
  }

  function startNextShop() {
    const next = queueRef.current.shift();
    if (!next) {
      setRunning(false);
      setActiveShop(null);
      currentRef.current = null;
      return;
    }
    currentRef.current = next;
    setActiveShop(next);
    submitScan(next.shop, "");
  }

  function startScan() {
    lastData.current = null;
    setRunning(true);
    setHasRun(true);
    setFatals([]);
    setCombined(emptyAgg());
    setPerStore(
      Object.fromEntries(
        reachableShops.map((s) => [
          s.shop,
          { scanned: 0, redirected: 0, byDetected: {} },
        ]),
      ),
    );
    setMatrix({});
    setOrders([]);
    setSampleCapped(false);
    setMapOrigin("ALL");
    sinceISORef.current = computeSinceISO(windowDays);
    queueRef.current = [...reachableShops];
    startNextShop();
  }

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const data = fetcher.data;
    if (!data || data.intent !== "scan" || data === lastData.current) return;
    lastData.current = data;

    const cur = currentRef.current;
    // A store's region comes from its selling currency (GBP -> GB, EUR -> EU),
    // so fold it onto the same canonical code the origin attribute uses.
    const destRegion = cur?.region
      ? canonicalStore(cur.region)
      : cur?.shop || "(unknown)";

    // Merge into combined totals.
    setCombined((prev) => {
      const next = {
        scanned: prev.scanned + (data.scanned || 0),
        redirected: prev.redirected + (data.redirected || 0),
        byOrigin: { ...prev.byOrigin },
        byDetected: { ...prev.byDetected },
        byCountry: { ...prev.byCountry },
        flows: { ...prev.flows },
      };
      mergeCounts(next.byOrigin, data.byOrigin);
      mergeCounts(next.byDetected, data.byDetected);
      mergeCounts(next.byCountry, data.byCountry);
      mergeCounts(next.flows, data.flows);
      return next;
    });

    // Per-store (this batch's destination = the store being scanned).
    setPerStore((prev) => {
      const key = data.shop;
      const bucket = prev[key] || { scanned: 0, redirected: 0, byDetected: {} };
      const merged = {
        scanned: bucket.scanned + (data.scanned || 0),
        redirected: bucket.redirected + (data.redirected || 0),
        byDetected: { ...bucket.byDetected },
      };
      mergeCounts(merged.byDetected, data.byDetected);
      return { ...prev, [key]: merged };
    });

    // Origin store -> destination store matrix. Every redirected order in this
    // batch landed on `destRegion`; its origin is in byOrigin.
    setMatrix((prev) => {
      const next = { ...prev };
      for (const [from, n] of Object.entries(data.byOrigin || {})) {
        const k = `${from}>${destRegion}`;
        next[k] = (next[k] || 0) + n;
      }
      return next;
    });

    // Per-order drill-down sample, tagged with the store it landed on.
    if (data.orders?.length) {
      setOrders((prev) => {
        if (prev.length >= CLIENT_SAMPLE_CAP) {
          setSampleCapped(true);
          return prev;
        }
        const room = CLIENT_SAMPLE_CAP - prev.length;
        if (data.orders.length > room) setSampleCapped(true);
        const tagged = data.orders.slice(0, room).map((o) => ({
          ...o,
          shop: data.shop,
          dest: destRegion,
        }));
        return [...prev, ...tagged];
      });
    }
    if (data.sampleCapped) setSampleCapped(true);

    if (data.fatal) {
      setFatals((f) => [
        ...f,
        `${cur?.name || data.shop}: ${data.fatal}`,
      ]);
    }

    if (data.done) {
      startNextShop();
    } else {
      submitScan(data.shop, data.nextCursor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const redirectRate = combined.scanned
    ? `${((combined.redirected / combined.scanned) * 100).toFixed(1)}%`
    : "-";

  // --- Table rows ------------------------------------------------------------
  const perStoreRows = useMemo(
    () =>
      reachableShops.map((s) => {
        const b = perStore[s.shop] || { scanned: 0, redirected: 0, byDetected: {} };
        const top = sortedEntries(b.byDetected)[0];
        const topLabel = top
          ? `${countryName(top[0])} (${top[1]})`
          : "-";
        return [
          `${s.flag ? `${s.flag} ` : ""}${s.name}`,
          b.scanned.toLocaleString(),
          b.redirected.toLocaleString(),
          pct(b.redirected, b.scanned),
          topLabel,
        ];
      }),
    [reachableShops, perStore],
  );

  const originRows = useMemo(
    () =>
      sortedEntries(combined.byOrigin).map(([code, n]) => [
        storeLabel(code),
        n,
        pct(n, combined.redirected),
      ]),
    [combined.byOrigin, combined.redirected],
  );

  const detectedRows = useMemo(
    () =>
      sortedEntries(combined.byDetected).map(([code, n]) => [
        code.startsWith("(") ? code : `${countryName(code)} (${code})`,
        n,
        pct(n, combined.redirected),
      ]),
    [combined.byDetected, combined.redirected],
  );

  const matrixRows = useMemo(
    () =>
      sortedEntries(matrix)
        .slice(0, 40)
        .map(([flow, n]) => {
          const [from, dest] = flow.split(">");
          return [storeLabel(from), storeLabel(dest), n, pct(n, combined.redirected)];
        }),
    [matrix, combined.redirected],
  );

  const orderRows = useMemo(
    () =>
      orders.map((o) => {
        const legacyId = o.legacyId;
        const url = `https://${o.shop}/admin/orders/${legacyId}`;
        return [
          <a href={url} target="_blank" rel="noreferrer" key={`${o.shop}-${o.name}`}>
            {o.name}
          </a>,
          storeLabel(o.dest),
          o.from ? storeLabel(o.from) : "-",
          o.detected ? `${countryName(o.detected)} (${o.detected})` : "-",
          o.country || "-",
          o.createdAt ? new Date(o.createdAt).toLocaleString() : "-",
        ];
      }),
    [orders],
  );

  function exportMatrixCSV() {
    const rows = sortedEntries(matrix).map(([flow, n]) => {
      const [from, dest] = flow.split(">");
      return [from, dest, n, pct(n, combined.redirected)];
    });
    downloadCSV(
      "redirect-flow-matrix.csv",
      ["From store", "To store", "Orders", "Share"],
      rows,
    );
  }

  function exportOrdersCSV() {
    const rows = orders.map((o) => [
      o.name,
      o.shop,
      o.dest,
      o.from,
      o.detected,
      o.country,
      o.createdAt,
    ]);
    downloadCSV(
      "redirect-orders.csv",
      [
        "Order",
        "Store domain",
        "Destination region",
        "Redirected from",
        "Detected country",
        "Country param",
        "Created at",
      ],
      rows,
    );
  }

  const originBarData = useMemo(
    () =>
      sortedEntries(combined.byOrigin).map(([code, n]) => ({
        label: storeLabel(code),
        value: n,
      })),
    [combined.byOrigin],
  );

  const detectedBarData = useMemo(
    () =>
      sortedEntries(combined.byDetected)
        .slice(0, 12)
        .map(([code, n]) => ({
          label: code.startsWith("(") ? code : `${countryName(code)} (${code})`,
          value: n,
        })),
    [combined.byDetected],
  );

  // Map filter: origin stores actually present, in canonical order + "All".
  const originFilterOptions = useMemo(() => {
    const present = Object.keys(combined.byOrigin).filter((c) => !c.startsWith("("));
    const canonical = ["AU", "UK", "EU", "US"];
    const ordered = [
      ...canonical.filter((c) => present.includes(c)),
      ...present.filter((c) => !canonical.includes(c)).sort(),
    ];
    return ["ALL", ...ordered];
  }, [combined.byOrigin]);

  // Detected-country counts feeding the map, filtered to a single origin store
  // by summing the FROM>DETECTED flow pairs. "ALL" uses the global breakdown.
  const mapCounts = useMemo(() => {
    if (mapOrigin === "ALL") return combined.byDetected;
    const out = {};
    for (const [flow, n] of Object.entries(combined.flows)) {
      const [from, detected] = flow.split(">");
      if (from === mapOrigin && !detected.startsWith("(")) {
        out[detected] = (out[detected] || 0) + n;
      }
    }
    return out;
  }, [mapOrigin, combined.byDetected, combined.flows]);

  const mapTotal = useMemo(
    () => Object.values(mapCounts).reduce((a, b) => a + b, 0),
    [mapCounts],
  );

  // Which stores the selected origin's visitors actually ended up buying on.
  const destForOrigin = useMemo(() => {
    if (mapOrigin === "ALL") return [];
    const out = {};
    for (const [flow, n] of Object.entries(matrix)) {
      const [from, dest] = flow.split(">");
      if (from === mapOrigin) out[dest] = (out[dest] || 0) + n;
    }
    return sortedEntries(out);
  }, [mapOrigin, matrix]);

  const unreachable = shops.filter((s) => !s.reachable);
  const scannedStores = Object.values(perStore).filter((b) => b.scanned > 0).length;

  return (
    <Page>
      <TitleBar title="Redirect Analytics" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              A cross-region summary of customers who arrived via a geo-redirect
              or the regionalisation popup. It scans orders on every store the
              app is installed on, reads the hidden{" "}
              <code>_hb_redirect_from</code> (store redirected from) and{" "}
              <code>_detected_country</code> (geo-detected country) attributes,
              and aggregates them. Each order&apos;s destination is the store it
              was placed on.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {reachableShops.length} store(s) will be scanned:{" "}
              {reachableShops.map((s) => `${s.flag} ${s.region || s.name}`).join(", ")}
            </Text>
            <InlineStack gap="300" blockAlign="end" wrap={false}>
              <Box minWidth="220px">
                <Select
                  label="Order window"
                  options={WINDOW_OPTIONS}
                  value={windowDays}
                  onChange={setWindowDays}
                  disabled={running}
                />
              </Box>
              <Button
                variant="primary"
                onClick={startScan}
                loading={running}
                disabled={running || reachableShops.length === 0}
              >
                Run report
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {unreachable.length > 0 && (
          <Banner tone="warning" title={`${unreachable.length} store(s) can't be reached`}>
            <Text as="p" variant="bodyMd">
              These installs have a stale token and are excluded from the report
              (reinstall to include them): {unreachable.map((s) => s.shop).join(", ")}
            </Text>
          </Banner>
        )}

        {(running || hasRun) && (
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="400" wrap>
                <Metric label="Orders scanned" value={combined.scanned.toLocaleString()} />
                <Metric label="Redirected orders" value={combined.redirected.toLocaleString()} />
                <Metric label="Redirect rate" value={redirectRate} />
                <Metric
                  label="Stores covered"
                  value={`${scannedStores}/${reachableShops.length}`}
                />
              </InlineStack>
              {running && (
                <BlockStack gap="150">
                  <ProgressBar progress={100} animated size="small" tone="primary" />
                  <Text as="span" variant="bodySm" tone="subdued">
                    Scanning {activeShop ? `${activeShop.flag} ${activeShop.name}` : "…"} -{" "}
                    {combined.scanned.toLocaleString()} orders so far.
                  </Text>
                </BlockStack>
              )}
              {!running && combined.redirected > 0 && (
                <InlineStack gap="200">
                  <Button onClick={exportMatrixCSV} disabled={Object.keys(matrix).length === 0}>
                    Download flow matrix CSV
                  </Button>
                  <Button onClick={exportOrdersCSV} disabled={orders.length === 0}>
                    Download orders CSV ({orders.length.toLocaleString()})
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        )}

        {fatals.length > 0 && (
          <Banner tone="critical" title="Some stores errored during the scan">
            <BlockStack gap="100">
              {fatals.map((f, i) => (
                <Text as="p" variant="bodySm" key={i}>{f}</Text>
              ))}
            </BlockStack>
          </Banner>
        )}

        {hasRun && !running && combined.redirected === 0 && fatals.length === 0 && (
          <Banner tone="info" title="No redirected orders found">
            <Text as="p" variant="bodyMd">
              None of the {combined.scanned.toLocaleString()} orders scanned carry
              redirect attributes. Try a wider window, or confirm the
              cart-redirect-attribute snippet is live on the storefronts.
            </Text>
          </Banner>
        )}

        {(running || hasRun) && (
          <Card padding="0">
            <Box padding="400" paddingBlockEnd="200">
              <Text as="h2" variant="headingMd">By store (destination)</Text>
            </Box>
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric", "text"]}
              headings={["Store", "Scanned", "Redirected", "Rate", "Top detected country"]}
              rows={perStoreRows}
            />
          </Card>
        )}

        {combined.redirected > 0 && (
          <>
            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    {mapOrigin === "ALL"
                      ? "Where customers are detected"
                      : `Where ${storeLabel(mapOrigin)} visitors are redirected to`}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {mapOrigin === "ALL"
                      ? "Redirected orders by geo-detected country across all stores. Darker = more orders. Hover a country for its total."
                      : `Geo-detected country of orders redirected away from the ${storeLabel(mapOrigin)} store - i.e. where those visitors actually were. ${mapTotal.toLocaleString()} order(s).`}
                  </Text>
                </BlockStack>
                {originFilterOptions.length > 1 && (
                  <ButtonGroup variant="segmented">
                    {originFilterOptions.map((opt) => (
                      <Button
                        key={opt}
                        pressed={mapOrigin === opt}
                        onClick={() => setMapOrigin(opt)}
                      >
                        {opt === "ALL" ? "All stores" : opt}
                      </Button>
                    ))}
                  </ButtonGroup>
                )}
                {destForOrigin.length > 0 && (
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Ended up purchasing on:
                    </Text>
                    {destForOrigin.map(([dest, n]) => (
                      <Badge key={dest} tone={dest === mapOrigin ? undefined : "info"}>
                        {`${storeLabel(dest)} · ${n.toLocaleString()}`}
                      </Badge>
                    ))}
                  </InlineStack>
                )}
                <WorldChoropleth
                  counts={mapCounts}
                  valueLabel="orders"
                  sourceIso={mapOrigin === "ALL" ? [] : sourceIsoFor(mapOrigin)}
                  sourceLabel={`${storeLabel(mapOrigin)} store (source)`}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <div
                  style={{
                    display: "grid",
                    gap: "var(--p-space-500, 20px)",
                    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  }}
                >
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">Redirected from (origin store)</Text>
                    <BarList data={originBarData} total={combined.redirected} />
                  </BlockStack>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">Top detected countries</Text>
                    <BarList data={detectedBarData} total={combined.redirected} />
                  </BlockStack>
                </div>
              </BlockStack>
            </Card>

            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <Text as="h2" variant="headingMd">Redirected from (origin store)</Text>
              </Box>
              <DataTable
                columnContentTypes={["text", "numeric", "numeric"]}
                headings={["Origin store", "Orders", "Share"]}
                rows={originRows}
              />
            </Card>

            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <Text as="h2" variant="headingMd">Detected country</Text>
              </Box>
              <DataTable
                columnContentTypes={["text", "numeric", "numeric"]}
                headings={["Detected country", "Orders", "Share"]}
                rows={detectedRows}
              />
            </Card>

            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Origin &rarr; destination flows</Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Which store customers were redirected from, and which store
                    they ended up purchasing on. Top 40 shown.
                  </Text>
                </BlockStack>
              </Box>
              <DataTable
                columnContentTypes={["text", "text", "numeric", "numeric"]}
                headings={["From store", "To store", "Orders", "Share"]}
                rows={matrixRows}
              />
            </Card>

            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Orders (drill-down)</Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Individual redirected orders, newest per store. Order numbers
                    link to the admin.
                    {sampleCapped
                      ? ` Showing the first ${orders.length.toLocaleString()} (sample capped) - aggregates above are complete.`
                      : ` ${orders.length.toLocaleString()} shown.`}
                  </Text>
                </BlockStack>
              </Box>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                headings={[
                  "Order",
                  "To store",
                  "From store",
                  "Detected country",
                  "Country param",
                  "Created",
                ]}
                rows={orderRows}
              />
            </Card>
          </>
        )}
      </BlockStack>
    </Page>
  );
}

function Metric({ label, value }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <Text as="span" variant="heading2xl">{value}</Text>
    </BlockStack>
  );
}
