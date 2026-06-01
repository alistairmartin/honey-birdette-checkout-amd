import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Page,
  Card,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Banner,
  Badge,
  IndexTable,
  Link as PolarisLink,
  EmptyState,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isConfigured, missingEnv } from "../lib/kibo.server";
import { sweepBatch, reimport, recheck } from "../lib/kiboChecker.server";

const STATUS_BADGE = {
  PENDING: { tone: "attention", label: "Pending" },
  EXISTS_IN_KIBO: { tone: "info", label: "Already in Kibo" },
  REIMPORTED: { tone: "success", label: "Reimported" },
  REIMPORT_FAILED: { tone: "critical", label: "Reimport failed" },
  IGNORED: { tone: undefined, label: "Ignored" },
};

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const orders = await prisma.kiboFailedOrder.findMany({
    where: { shop },
    orderBy: { detectedAt: "desc" },
    take: 500,
  });
  const pendingCount = orders.filter((o) => o.status === "PENDING").length;
  return json({
    shop,
    orders,
    pendingCount,
    kiboConfigured: isConfigured(shop),
    missingEnv: missingEnv(shop),
    // Reimport is built but off by default - this page is identify-only until
    // KIBO_REIMPORT_ENABLED=true is set on the server.
    reimportEnabled: process.env.KIBO_REIMPORT_ENABLED === "true",
  });
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "sweep") {
    const cursor = form.get("cursor") || null;
    const result = await sweepBatch({ admin, shop, cursor });
    return json({ intent, ...result });
  }

  if (intent === "recheck") {
    const result = await recheck({ shop, recordId: form.get("recordId") });
    return json({ intent, ...result });
  }

  if (intent === "reimport") {
    // Identify-only mode: reimport stays disabled until explicitly enabled.
    if (process.env.KIBO_REIMPORT_ENABLED !== "true") {
      return json({
        intent,
        ok: false,
        message: "Reimport is disabled (identify-only mode).",
      });
    }
    const result = await reimport({ admin, shop, recordId: form.get("recordId") });
    return json({ intent, ...result });
  }

  return json({ intent: null, message: "Unknown action." }, { status: 400 });
}

export default function KiboChecker() {
  const { shop, orders, pendingCount, kiboConfigured, missingEnv, reimportEnabled } =
    useLoaderData();
  const revalidator = useRevalidator();

  // --- Sweep fetcher with batched resume loop (same pattern as cleanup page) --
  const sweepFetcher = useFetcher();
  const lastData = useRef(null);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState({ scanned: 0, flagged: 0, recovered: 0 });
  const [sweepErrors, setSweepErrors] = useState([]);
  const [fatal, setFatal] = useState(null);

  useEffect(() => {
    if (sweepFetcher.state !== "idle") return;
    const data = sweepFetcher.data;
    if (!data || data.intent !== "sweep" || data === lastData.current) return;
    lastData.current = data;

    setTotals((t) => ({
      scanned: t.scanned + data.pageScanned,
      flagged: t.flagged + data.pageFlagged,
      recovered: t.recovered + data.pageRecovered,
    }));
    if (data.errors?.length) setSweepErrors((e) => [...e, ...data.errors]);
    if (data.fatalError) setFatal(data.fatalError);

    if (data.done) {
      setRunning(false);
      revalidator.revalidate(); // refresh the table with new rows
    } else {
      sweepFetcher.submit(
        { intent: "sweep", cursor: data.nextCursor },
        { method: "post" },
      );
    }
  }, [sweepFetcher.state, sweepFetcher.data]);

  function startSweep() {
    lastData.current = null;
    setRunning(true);
    setTotals({ scanned: 0, flagged: 0, recovered: 0 });
    setSweepErrors([]);
    setFatal(null);
    sweepFetcher.submit({ intent: "sweep", cursor: "" }, { method: "post" });
  }

  // --- Per-row action fetcher (one row at a time) ----------------------------
  const rowFetcher = useFetcher();
  const busyId = rowFetcher.state !== "idle" ? rowFetcher.formData?.get("recordId") : null;

  function rowAction(intent, recordId) {
    rowFetcher.submit({ intent, recordId }, { method: "post" });
  }

  const rowMessage = rowFetcher.state === "idle" ? rowFetcher.data : null;

  const rows = orders.map((o, index) => {
    const badge = STATUS_BADGE[o.status] || { label: o.status };
    const legacyId = o.shopifyOrderId.split("/").pop();
    const isBusy = busyId === o.id;
    const canReimport = o.status === "PENDING" || o.status === "REIMPORT_FAILED";
    return (
      <IndexTable.Row id={o.id} key={o.id} position={index}>
        <IndexTable.Cell>
          <PolarisLink url={`https://${shop}/admin/orders/${legacyId}`} target="_blank">
            {o.shopifyOrderName}
          </PolarisLink>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm">{o.reason}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm" tone="subdued">{o.suggestion}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm" tone="subdued">
            {new Date(o.detectedAt).toLocaleString()}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <InlineStack gap="200" wrap={false}>
            <Button
              size="slim"
              onClick={() => rowAction("recheck", o.id)}
              loading={isBusy && rowFetcher.formData?.get("intent") === "recheck"}
              disabled={!kiboConfigured || isBusy}
            >
              Re-check
            </Button>
            {/* Reimport is built but hidden until KIBO_REIMPORT_ENABLED=true. */}
            {reimportEnabled && (
              <Button
                size="slim"
                variant="primary"
                onClick={() => rowAction("reimport", o.id)}
                loading={isBusy && rowFetcher.formData?.get("intent") === "reimport"}
                disabled={!kiboConfigured || isBusy || !canReimport}
              >
                Reimport
              </Button>
            )}
          </InlineStack>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page>
      <TitleBar title="Kibo Checker" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Finds orders that exist in Shopify but never imported into Kibo
              (it lists recent Shopify orders and asks Kibo which it has). Each
              one shows a likely reason and a suggested fix so you can follow up.
              {reimportEnabled
                ? " Reimport re-checks Kibo first, so an order the warehouse already keyed in by hand is never duplicated."
                : " This is identify-only for now - reimport is disabled."}
            </Text>
            <InlineStack gap="300" blockAlign="center">
              <Button
                onClick={startSweep}
                loading={running}
                disabled={running || !kiboConfigured}
                variant="primary"
              >
                Run sweep now
              </Button>
              {pendingCount > 0 && (
                <Badge tone="attention">{`${pendingCount} pending`}</Badge>
              )}
            </InlineStack>
          </BlockStack>
        </Card>

        {!kiboConfigured && (
          <Banner tone="warning" title={`Kibo is not configured for ${shop}`}>
            <Text as="p" variant="bodyMd">
              This region's Kibo settings are missing from the <code>KIBO_REGIONS</code>{" "}
              config on the server. Missing: {missingEnv.join(", ")}. Sweeps and
              reimports are disabled until they are set.
            </Text>
          </Banner>
        )}

        {(running || totals.scanned > 0) && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                {running ? "Sweeping…" : "Sweep complete"}
              </Text>
              <Text as="p" variant="bodyMd">
                {totals.scanned} order(s) checked - {totals.flagged} newly
                flagged as missing, {totals.recovered} found to have recovered.
              </Text>
            </BlockStack>
          </Card>
        )}

        {fatal && (
          <Banner tone="critical" title="The sweep stopped early">
            <Text as="p" variant="bodyMd">{fatal}</Text>
          </Banner>
        )}

        {sweepErrors.length > 0 && (
          <Banner tone="warning" title={`${sweepErrors.length} order(s) errored during the sweep`}>
            <Box paddingBlockStart="200">
              <BlockStack gap="100">
                {sweepErrors.slice(0, 20).map((e, i) => (
                  <Text as="p" variant="bodySm" key={i}>{e}</Text>
                ))}
              </BlockStack>
            </Box>
          </Banner>
        )}

        {rowMessage?.message && (
          <Banner
            tone={rowMessage.ok ? "success" : "critical"}
            onDismiss={() => {}}
          >
            <Text as="p" variant="bodyMd">{rowMessage.message}</Text>
          </Banner>
        )}

        <Card padding="0">
          {orders.length === 0 ? (
            <Box padding="400">
              <EmptyState heading="No failed orders recorded" image="">
                <p>
                  Run a sweep to check recent Shopify orders against Kibo.
                  Anything missing will appear here.
                </p>
              </EmptyState>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={orders.length}
              headings={[
                { title: "Order" },
                { title: "Status" },
                { title: "Reason" },
                { title: "Suggestion" },
                { title: "Detected" },
                { title: "Actions" },
              ]}
            >
              {rows}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
