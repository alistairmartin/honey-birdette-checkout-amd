import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { regionForShop, tierTagsForRegion } from "../lib/loyaltyTierSync.server";
import { backfillOrderLoyaltyTags } from "../lib/loyaltyOrderTags.server";

// Kept in sync with ORDER_TAG_PREFIX in loyaltyOrderTags.server.js (that
// module is server-only, so the component can't import it).
const ORDER_TAG_PREFIX = "Loyalty:";
const DAY_OPTIONS = [7, 14, 30];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const region = regionForShop(shop);
  return json({
    shop,
    region,
    tiers: region
      ? tierTagsForRegion(region).map((t) => ({ tag: t.tag, value: t.value }))
      : [],
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const region = regionForShop(session.shop);
  if (!region) {
    return json(
      { fatalError: `No region mapped for ${session.shop}`, done: true },
      { status: 400 },
    );
  }
  const form = await request.formData();
  const apply = form.get("apply") === "true";
  const cursor = form.get("cursor") || null;
  const days = DAY_OPTIONS.includes(Number(form.get("days")))
    ? Number(form.get("days"))
    : 7;
  const result = await backfillOrderLoyaltyTags(admin, region, {
    days,
    apply,
    cursor,
  });
  return json(result);
};

export default function LoyaltyOrderTagsPage() {
  const { shop, region, tiers } = useLoaderData();
  const fetcher = useFetcher();
  const lastData = useRef(null);
  const [days, setDays] = useState("7");
  const [running, setRunning] = useState(false);
  const [apply, setApply] = useState(false);
  const [finished, setFinished] = useState(false);
  const [batches, setBatches] = useState(0);
  const [totals, setTotals] = useState({
    scanned: 0,
    matched: 0,
    alreadyTagged: 0,
    noTier: 0,
    tagged: 0,
  });
  const [perTier, setPerTier] = useState({});
  const [matchedOrders, setMatchedOrders] = useState([]);
  const [errors, setErrors] = useState([]);
  const [fatal, setFatal] = useState(null);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const data = fetcher.data;
    if (!data || data === lastData.current) return;
    lastData.current = data;

    setTotals((t) => ({
      scanned: t.scanned + (data.pageScanned ?? 0),
      matched: t.matched + (data.pageMatched ?? 0),
      alreadyTagged: t.alreadyTagged + (data.pageAlreadyTagged ?? 0),
      noTier: t.noTier + (data.pageNoTier ?? 0),
      tagged: t.tagged + (data.pageTagged ?? 0),
    }));
    setBatches((b) => b + 1);
    if (data.perTier) {
      setPerTier((p) => {
        const next = { ...p };
        for (const [k, v] of Object.entries(data.perTier)) {
          next[k] = (next[k] ?? 0) + v;
        }
        return next;
      });
    }
    if (data.matchedOrders?.length)
      setMatchedOrders((o) => [...o, ...data.matchedOrders]);
    if (data.errors?.length) setErrors((e) => [...e, ...data.errors]);
    if (data.fatalError) setFatal(data.fatalError);

    if (data.done) {
      setRunning(false);
      setFinished(true);
    } else {
      fetcher.submit(
        { apply: String(data.apply), cursor: data.nextCursor, days: String(data.days) },
        { method: "post" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  function start(applyMode) {
    lastData.current = null;
    setRunning(true);
    setFinished(false);
    setApply(applyMode);
    setBatches(0);
    setTotals({ scanned: 0, matched: 0, alreadyTagged: 0, noTier: 0, tagged: 0 });
    setPerTier({});
    setMatchedOrders([]);
    setErrors([]);
    setFatal(null);
    fetcher.submit(
      { apply: String(applyMode), cursor: "", days },
      { method: "post" },
    );
  }

  return (
    <Page>
      <TitleBar title="Loyalty order tags backfill" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Tag recent orders with the customer&apos;s loyalty tier
                </Text>
                {region ? (
                  <Badge tone="success">Region: {region.toUpperCase()}</Badge>
                ) : (
                  <Badge tone="critical">Unknown store</Badge>
                )}
              </InlineStack>

              <Text as="p" variant="bodyMd">
                Scans orders on <strong>{shop}</strong> created in the chosen
                window and adds a <code>{ORDER_TAG_PREFIX}Tier</code> tag based
                on the customer&apos;s loyalty tag. Orders that already carry a{" "}
                <code>{ORDER_TAG_PREFIX}</code> tag are skipped, so it is safe to
                re-run. Existing order tags are preserved.
              </Text>

              {region ? (
                <List type="bullet">
                  {tiers.map((t) => (
                    <List.Item key={t.tag}>
                      <code>{t.tag}</code> &rarr;{" "}
                      <code>
                        {ORDER_TAG_PREFIX}
                        {t.value}
                      </code>
                    </List.Item>
                  ))}
                </List>
              ) : (
                <Text as="p" variant="bodyMd" tone="critical">
                  This shop isn&apos;t mapped to a region (au/uk/us/eu). Add it to
                  <code> SHOP_REGION</code> in
                  <code> app/lib/loyaltyTierSync.server.js</code>.
                </Text>
              )}

              <Box maxWidth="240px">
                <Select
                  label="Orders created in the last"
                  options={DAY_OPTIONS.map((d) => ({
                    label: `${d} days`,
                    value: String(d),
                  }))}
                  value={days}
                  onChange={setDays}
                  disabled={running}
                />
              </Box>

              <InlineStack gap="200">
                <Button
                  onClick={() => start(false)}
                  disabled={!region || running}
                  loading={running && !apply}
                >
                  Preview (no changes)
                </Button>
                <Button
                  variant="primary"
                  onClick={() => start(true)}
                  disabled={!region || running}
                  loading={running && apply}
                >
                  Apply tags
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {batches > 0 ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    {apply ? "Apply" : "Preview"}
                  </Text>
                  {running ? (
                    <Badge tone="attention">Running, batch {batches}</Badge>
                  ) : finished ? (
                    apply ? (
                      <Badge tone="success">Applied</Badge>
                    ) : (
                      <Badge>Dry run</Badge>
                    )
                  ) : null}
                </InlineStack>

                <Text as="p" variant="bodyMd">
                  {totals.scanned} order(s) scanned &middot; {totals.matched}{" "}
                  {apply ? "tagged" : "would be tagged"} &middot;{" "}
                  {totals.alreadyTagged} already tagged &middot; {totals.noTier}{" "}
                  with no tier
                  {apply && totals.tagged !== totals.matched
                    ? ` · ${totals.tagged} succeeded`
                    : ""}
                </Text>

                {Object.keys(perTier).length ? (
                  <List type="bullet">
                    {Object.entries(perTier).map(([tier, n]) => (
                      <List.Item key={tier}>
                        <code>
                          {ORDER_TAG_PREFIX}
                          {tier}
                        </code>
                        : {n} order(s)
                      </List.Item>
                    ))}
                  </List>
                ) : null}

                {fatal ? (
                  <Box padding="300" background="bg-surface-critical" borderRadius="200">
                    <Text as="pre" variant="bodySm">
                      {fatal}
                    </Text>
                  </Box>
                ) : null}

                {errors.length ? (
                  <Box padding="300" background="bg-surface-critical" borderRadius="200">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="critical">
                        {errors.length} error(s):
                      </Text>
                      <Text as="pre" variant="bodySm">
                        {errors.join("\n")}
                      </Text>
                    </BlockStack>
                  </Box>
                ) : null}

                {matchedOrders.length ? (
                  <Box
                    padding="300"
                    background="bg-surface-secondary"
                    borderRadius="200"
                  >
                    <Text as="pre" variant="bodySm">
                      {matchedOrders.map((o) => `${o.name}  ${o.tag}`).join("\n")}
                    </Text>
                  </Box>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}
      </Layout>
    </Page>
  );
}
