import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Page,
  Card,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Banner,
  List,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const ATTRIBUTE_KEY = "_client_info";
const DAYS = 4;
// Process orders for at most this long per request, then hand a cursor back to
// the browser so it can resume. Keeps each request well under the dev-tunnel
// (~100s) and most hosting request timeouts.
const BUDGET_MS = 25_000;
// Cap on collected userErrors so the response payload stays small.
const MAX_ERRORS = 50;

const ORDERS_QUERY = `#graphql
  query OrdersWithAttrs($q: String!, $cursor: String) {
    orders(first: 100, query: $q, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { id name createdAt customAttributes { key value } }
    }
  }`;

const ORDER_UPDATE = `#graphql
  mutation RemoveClientInfo($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to wait after a THROTTLED response: drain the cost deficit at the
// shop's restore rate, falling back to exponential backoff.
function throttleBackoff(body, attempt) {
  const cost = body?.extensions?.cost;
  const status = cost?.throttleStatus;
  if (status) {
    const deficit = (cost.requestedQueryCost ?? 100) - status.currentlyAvailable;
    const rate = status.restoreRate || 100;
    if (deficit > 0) return Math.min((deficit / rate) * 1000 + 250, 8000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

// Proactive pacing: if the cost bucket is running low after a write, pause so
// we don't walk straight into a THROTTLED error on the next call.
function costPause(body) {
  const status = body?.extensions?.cost?.throttleStatus;
  if (!status) return 0;
  if (status.currentlyAvailable < 200) {
    const rate = status.restoreRate || 100;
    return Math.min(((200 - status.currentlyAvailable) / rate) * 1000, 3000);
  }
  return 0;
}

// Run a GraphQL operation, retrying on cost-based throttling.
async function adminGraphql(admin, query, variables, attempt = 0) {
  const MAX = 6;
  try {
    const res = await admin.graphql(query, { variables });
    const body = await res.json();
    if (body.errors?.length) {
      const throttled = body.errors.some(
        (e) => e.extensions?.code === "THROTTLED",
      );
      if (throttled && attempt < MAX) {
        await sleep(throttleBackoff(body, attempt));
        return adminGraphql(admin, query, variables, attempt + 1);
      }
      throw new Error(body.errors.map((e) => e.message).join("; "));
    }
    return body;
  } catch (err) {
    // shopify-app-remix throws GraphqlQueryError for some failures; its .body
    // carries the same errors array.
    const throttled =
      err?.body?.errors?.some?.(
        (e) => e.extensions?.code === "THROTTLED",
      ) || /throttl/i.test(err?.message || "");
    if (throttled && attempt < MAX) {
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      return adminGraphql(admin, query, variables, attempt + 1);
    }
    throw err;
  }
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const apply = form.get("apply") === "true";
  let cursor = form.get("cursor") || null;
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const q = `created_at:>='${since}'`;

  const deadline = Date.now() + BUDGET_MS;
  let scanned = 0;
  let affected = 0;
  let updated = 0;
  let done = false;
  const errors = [];

  try {
    while (true) {
      const body = await adminGraphql(admin, ORDERS_QUERY, { q, cursor });
      const orders = body.data.orders;

      for (const order of orders.nodes) {
        scanned++;
        const hasAttr = order.customAttributes.some(
          (a) => a.key === ATTRIBUTE_KEY,
        );
        if (!hasAttr) continue;
        affected++;
        if (!apply) continue;

        // customAttributes is replace-all: re-submit every attribute except
        // the one we're dropping so the rest are preserved.
        const kept = order.customAttributes
          .filter((a) => a.key !== ATTRIBUTE_KEY)
          .map((a) => ({ key: a.key, value: a.value }));

        const upd = await adminGraphql(admin, ORDER_UPDATE, {
          input: { id: order.id, customAttributes: kept },
        });
        const userErrors = upd.data.orderUpdate.userErrors || [];
        if (userErrors.length) {
          if (errors.length < MAX_ERRORS) {
            errors.push(`${order.name}: ${userErrors.map((e) => e.message).join(", ")}`);
          }
        } else {
          updated++;
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
    return json({
      apply,
      done: true,
      nextCursor: null,
      pageScanned: scanned,
      pageAffected: affected,
      pageUpdated: updated,
      errors,
      fatalError: err?.message || String(err),
    });
  }

  return json({
    apply,
    done,
    nextCursor: cursor,
    pageScanned: scanned,
    pageAffected: affected,
    pageUpdated: updated,
    errors,
    fatalError: null,
  });
}

export default function ClientInfoCleanup() {
  const fetcher = useFetcher();
  const lastData = useRef(null);
  const [running, setRunning] = useState(false);
  const [apply, setApply] = useState(false);
  const [finished, setFinished] = useState(false);
  const [batches, setBatches] = useState(0);
  const [totals, setTotals] = useState({ scanned: 0, affected: 0, updated: 0 });
  const [errors, setErrors] = useState([]);
  const [fatal, setFatal] = useState(null);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const data = fetcher.data;
    // Each response is a fresh object; identity check dedupes the effect.
    if (!data || data === lastData.current) return;
    lastData.current = data;

    setTotals((t) => ({
      scanned: t.scanned + data.pageScanned,
      affected: t.affected + data.pageAffected,
      updated: t.updated + data.pageUpdated,
    }));
    setBatches((b) => b + 1);
    if (data.errors?.length) setErrors((e) => [...e, ...data.errors]);
    if (data.fatalError) setFatal(data.fatalError);

    if (data.done) {
      setRunning(false);
      setFinished(true);
    } else {
      // Resume from where this batch stopped.
      fetcher.submit(
        { apply: String(data.apply), cursor: data.nextCursor },
        { method: "post" },
      );
    }
  }, [fetcher.state, fetcher.data]);

  function start(applyMode) {
    lastData.current = null;
    setRunning(true);
    setFinished(false);
    setApply(applyMode);
    setBatches(0);
    setTotals({ scanned: 0, affected: 0, updated: 0 });
    setErrors([]);
    setFatal(null);
    fetcher.submit(
      { apply: String(applyMode), cursor: "" },
      { method: "post" },
    );
  }

  return (
    <Page>
      <TitleBar title="Remove _client_info from recent orders" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              Scans every order created in the last {DAYS} days and removes the{" "}
              <code>{ATTRIBUTE_KEY}</code> note attribute. All other attributes
              on each order are preserved. This cleans the store whose admin
              you are currently in — open the app in each store to clean it.
            </Text>
            <InlineStack gap="300">
              <Button onClick={() => start(false)} disabled={running} loading={running && !apply}>
                Dry run
              </Button>
              <Button
                onClick={() => start(true)}
                disabled={running}
                loading={running && apply}
                variant="primary"
                tone="critical"
              >
                Apply — remove attribute
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {(running || finished) && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                {running
                  ? apply
                    ? "Removing…"
                    : "Scanning…"
                  : apply
                    ? "Done"
                    : "Dry run complete"}
              </Text>
              <Text as="p" variant="bodyMd">
                {totals.scanned} order(s) scanned across {batches} batch(es).
              </Text>
              <Text as="p" variant="bodyMd">
                {totals.affected} order(s) have <code>{ATTRIBUTE_KEY}</code>
                {apply
                  ? ` — ${totals.updated} updated.`
                  : " (dry run — nothing changed)."}
              </Text>
            </BlockStack>
          </Card>
        )}

        {fatal && (
          <Banner tone="critical" title="The run stopped early">
            <Text as="p" variant="bodyMd">{fatal}</Text>
          </Banner>
        )}

        {errors.length > 0 && (
          <Banner tone="warning" title={`${errors.length} order(s) reported errors`}>
            <Box paddingBlockStart="200">
              <List>
                {errors.map((e, i) => (
                  <List.Item key={i}>{e}</List.Item>
                ))}
              </List>
            </Box>
          </Banner>
        )}
      </BlockStack>
    </Page>
  );
}
