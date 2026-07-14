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

const PARENT_PRODUCT_TYPE = "Lingerie Set";
const SET_ITEMS_NAMESPACE = "custom";
const SET_ITEMS_KEY = "set_product_items";
const PARENT_REF_NAMESPACE = "custom";
const PARENT_REF_KEY = "lingerie_set_parent";

// Only children of these product types get the parent reference written.
const ELIGIBLE_CHILD_TYPES = new Set([
  "Bodysuit",
  "Bra",
  "Brief",
  "Bustier",
  "Chemise",
  "Dress",
  "Pants",
  "Robe",
  "Skirt",
  "Suspender",
  "Thong",
  "Top",
]);

// Parent sets are stored on the child in this order. Ranked by handle suffix,
// most specific first ("lian-complete-lingerie-set" also ends with
// "lingerie-set", so "complete-lingerie-set" has to be tested first). Anything
// that matches nothing here sorts last, keeping its existing relative order.
const PARENT_HANDLE_ORDER = [
  "complete-lingerie-set",
  "3-piece-lingerie-set",
  "2-piece-lingerie-set",
  "lingerie-set",
];

// Hand back a cursor after this long so the browser can resume. Keeps each
// request well under dev-tunnel / hosting timeouts.
const BUDGET_MS = 25_000;
const MAX_ERRORS = 50;

// Paginate parent lingerie-set products and read their set_product_items
// metafield (which is itself a paginated list).
const PARENTS_QUERY = `#graphql
  query LingerieSetParents($q: String!, $cursor: String) {
    products(first: 25, query: $q, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        productType
        setItems: metafield(namespace: "${SET_ITEMS_NAMESPACE}", key: "${SET_ITEMS_KEY}") {
          references(first: 50) {
            nodes {
              __typename
              ... on Product {
                id
                productType
                parentRef: metafield(namespace: "${PARENT_REF_NAMESPACE}", key: "${PARENT_REF_KEY}") {
                  value
                }
              }
            }
          }
        }
      }
    }
  }`;

// Existing entries on a child can point at parents we have not paged past yet,
// so their handles have to be looked up before the list can be sorted.
const PARENT_HANDLES_QUERY = `#graphql
  query ParentHandles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
      }
    }
  }`;

const METAFIELDS_SET = `#graphql
  mutation SetParentRef($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace ownerType }
      userErrors { field message code }
    }
  }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function costPause(body) {
  const status = body?.extensions?.cost?.throttleStatus;
  if (!status) return 0;
  if (status.currentlyAvailable < 200) {
    const rate = status.restoreRate || 100;
    return Math.min(((200 - status.currentlyAvailable) / rate) * 1000, 3000);
  }
  return 0;
}

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
    const throttled =
      err?.body?.errors?.some?.((e) => e.extensions?.code === "THROTTLED") ||
      /throttl/i.test(err?.message || "");
    if (throttled && attempt < MAX) {
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      return adminGraphql(admin, query, variables, attempt + 1);
    }
    throw err;
  }
}

// list.product_reference metafields store a JSON-encoded array of GIDs.
function parseRefList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parentRank(handle) {
  if (!handle) return PARENT_HANDLE_ORDER.length;
  const i = PARENT_HANDLE_ORDER.findIndex((suffix) => handle.endsWith(suffix));
  return i === -1 ? PARENT_HANDLE_ORDER.length : i;
}

// Array#sort is stable, so unranked parents keep the order they came in with.
function sortParentRefs(ids, handles) {
  return [...ids].sort(
    (a, b) => parentRank(handles.get(a)) - parentRank(handles.get(b)),
  );
}

// Fills `handles` for any GID we have not already seen. 250 is the nodes() cap.
async function cacheHandles(admin, ids, handles) {
  const missing = [...new Set(ids)].filter((id) => !handles.has(id));
  for (let i = 0; i < missing.length; i += 250) {
    const body = await adminGraphql(admin, PARENT_HANDLES_QUERY, {
      ids: missing.slice(i, i + 250),
    });
    for (const node of body.data.nodes || []) {
      if (node?.id && node.handle) handles.set(node.id, node.handle);
    }
  }
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const apply = form.get("apply") === "true";
  let cursor = form.get("cursor") || null;
  const q = `product_type:"${PARENT_PRODUCT_TYPE}"`;

  const deadline = Date.now() + BUDGET_MS;
  let parentsScanned = 0;
  let childrenSeen = 0;
  let childrenEligible = 0;
  let writesPlanned = 0;
  let writesApplied = 0;
  let reordersPlanned = 0;
  let done = false;
  const errors = [];
  const handles = new Map();
  // A child can sit in more than one parent set on the same page, and its
  // metafield value in the query response is a snapshot from before this run's
  // writes. Track what we last wrote so the second parent merges instead of
  // clobbering the first.
  const childLists = new Map();

  try {
    while (true) {
      const body = await adminGraphql(admin, PARENTS_QUERY, { q, cursor });
      const products = body.data.products;

      for (const parent of products.nodes) {
        parentsScanned++;
        if (parent.handle) handles.set(parent.id, parent.handle);

        const childRefs = parent.setItems?.references?.nodes || [];
        if (!childRefs.length) continue;

        const eligible = [];
        for (const child of childRefs) {
          if (child.__typename !== "Product") continue;
          childrenSeen++;
          if (!ELIGIBLE_CHILD_TYPES.has(child.productType)) continue;
          childrenEligible++;
          eligible.push(child);
        }
        if (!eligible.length) continue;

        // Sorting needs the handle of every parent already on these children.
        await cacheHandles(
          admin,
          eligible.flatMap((c) => parseRefList(c.parentRef?.value)),
          handles,
        );

        const toWrite = [];
        for (const child of eligible) {
          const existing =
            childLists.get(child.id) ?? parseRefList(child.parentRef?.value);
          const merged = existing.includes(parent.id)
            ? existing
            : [...existing, parent.id];
          const sorted = sortParentRefs(merged, handles);
          if (JSON.stringify(sorted) === JSON.stringify(existing)) continue;
          if (existing.includes(parent.id)) reordersPlanned++;
          childLists.set(child.id, sorted);

          toWrite.push({
            ownerId: child.id,
            namespace: PARENT_REF_NAMESPACE,
            key: PARENT_REF_KEY,
            type: "list.product_reference",
            value: JSON.stringify(sorted),
          });
        }

        writesPlanned += toWrite.length;
        if (!apply || toWrite.length === 0) continue;

        // metafieldsSet accepts up to 25 inputs per call.
        for (let i = 0; i < toWrite.length; i += 25) {
          const batch = toWrite.slice(i, i + 25);
          const resp = await adminGraphql(admin, METAFIELDS_SET, {
            metafields: batch,
          });
          const userErrors = resp.data.metafieldsSet.userErrors || [];
          if (userErrors.length) {
            for (const e of userErrors) {
              if (errors.length >= MAX_ERRORS) break;
              errors.push(`${parent.title}: ${e.message}`);
            }
          }
          writesApplied +=
            (resp.data.metafieldsSet.metafields || []).length;

          const pause = costPause(resp);
          if (pause) await sleep(pause);
        }
      }

      cursor = products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null;
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
      pageParents: parentsScanned,
      pageChildren: childrenSeen,
      pageEligible: childrenEligible,
      pagePlanned: writesPlanned,
      pageApplied: writesApplied,
      pageReordered: reordersPlanned,
      errors,
      fatalError: err?.message || String(err),
    });
  }

  return json({
    apply,
    done,
    nextCursor: cursor,
    pageParents: parentsScanned,
    pageChildren: childrenSeen,
    pageEligible: childrenEligible,
    pagePlanned: writesPlanned,
    pageApplied: writesApplied,
    pageReordered: reordersPlanned,
    errors,
    fatalError: null,
  });
}

export default function LingerieSetSync() {
  const fetcher = useFetcher();
  const lastData = useRef(null);
  const [running, setRunning] = useState(false);
  const [apply, setApply] = useState(false);
  const [finished, setFinished] = useState(false);
  const [batches, setBatches] = useState(0);
  const [totals, setTotals] = useState({
    parents: 0,
    children: 0,
    eligible: 0,
    planned: 0,
    applied: 0,
    reordered: 0,
  });
  const [errors, setErrors] = useState([]);
  const [fatal, setFatal] = useState(null);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const data = fetcher.data;
    if (!data || data === lastData.current) return;
    lastData.current = data;

    setTotals((t) => ({
      parents: t.parents + data.pageParents,
      children: t.children + data.pageChildren,
      eligible: t.eligible + data.pageEligible,
      planned: t.planned + data.pagePlanned,
      applied: t.applied + data.pageApplied,
      reordered: t.reordered + (data.pageReordered || 0),
    }));
    setBatches((b) => b + 1);
    if (data.errors?.length) setErrors((e) => [...e, ...data.errors]);
    if (data.fatalError) setFatal(data.fatalError);

    if (data.done) {
      setRunning(false);
      setFinished(true);
    } else {
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
    setTotals({
      parents: 0,
      children: 0,
      eligible: 0,
      planned: 0,
      applied: 0,
      reordered: 0,
    });
    setErrors([]);
    setFatal(null);
    fetcher.submit(
      { apply: String(applyMode), cursor: "" },
      { method: "post" },
    );
  }

  return (
    <Page>
      <TitleBar title="Sync lingerie set parents to children" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              Finds every product whose product type is{" "}
              <code>{PARENT_PRODUCT_TYPE}</code>, reads its{" "}
              <code>
                {SET_ITEMS_NAMESPACE}.{SET_ITEMS_KEY}
              </code>{" "}
              metafield, and adds the parent set to each child's{" "}
              <code>
                {PARENT_REF_NAMESPACE}.{PARENT_REF_KEY}
              </code>{" "}
              list. Only children whose product type is one of:{" "}
              {[...ELIGIBLE_CHILD_TYPES].join(", ")} are updated. Existing
              entries are preserved.
            </Text>
            <Text as="p" variant="bodyMd">
              The list is sorted by parent handle so the first entry is the most
              complete set: {PARENT_HANDLE_ORDER.map((h) => `*-${h}`).join(", ")},
              then anything else. Children whose parents are already correct but
              in the wrong order get rewritten.
            </Text>
            <InlineStack gap="300">
              <Button
                onClick={() => start(false)}
                disabled={running}
                loading={running && !apply}
              >
                Dry run
              </Button>
              <Button
                onClick={() => start(true)}
                disabled={running}
                loading={running && apply}
                variant="primary"
              >
                Apply - sync parents
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
                    ? "Syncing..."
                    : "Scanning..."
                  : apply
                    ? "Done"
                    : "Dry run complete"}
              </Text>
              <Text as="p" variant="bodyMd">
                {totals.parents} parent set(s) scanned across {batches}{" "}
                batch(es).
              </Text>
              <Text as="p" variant="bodyMd">
                {totals.children} child reference(s) seen,{" "}
                {totals.eligible} of an eligible product type.
              </Text>
              <Text as="p" variant="bodyMd">
                {totals.planned} child metafield(s) to update, of which{" "}
                {totals.reordered} are re-ordering only
                {apply ? ` - ${totals.applied} written.` : " (dry run - nothing changed)."}
              </Text>
            </BlockStack>
          </Card>
        )}

        {fatal && (
          <Banner tone="critical" title="The run stopped early">
            <Text as="p" variant="bodyMd">
              {fatal}
            </Text>
          </Banner>
        )}

        {errors.length > 0 && (
          <Banner
            tone="warning"
            title={`${errors.length} write(s) reported errors`}
          >
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
