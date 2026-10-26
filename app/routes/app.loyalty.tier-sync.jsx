import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
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
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  regionForShop,
  tierTagsForRegion,
  syncLoyaltyTiers,
} from "../lib/loyaltyTierSync.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const region = regionForShop(shop);
  return json({
    shop,
    region,
    tags: region ? tierTagsForRegion(region).map((t) => t.tag) : [],
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const region = regionForShop(session.shop);
  if (!region) {
    return json(
      { ok: false, error: `No region mapped for ${session.shop}` },
      { status: 400 },
    );
  }
  const formData = await request.formData();
  const dryRun = formData.get("intent") === "preview";
  try {
    const result = await syncLoyaltyTiers(admin, region, { dryRun });
    return json({ ok: true, result });
  } catch (err) {
    return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
};

export default function LoyaltyTierSyncPage() {
  const { shop, region, tags } = useLoaderData();
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  const submittingIntent = fetcher.formData?.get("intent");
  const data = fetcher.data;
  const result = data?.ok ? data.result : null;

  return (
    <Page>
      <TitleBar title="Loyalty tier sync" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Sync loyalty tier from tags
                </Text>
                {region ? (
                  <Badge tone="success">Region: {region.toUpperCase()}</Badge>
                ) : (
                  <Badge tone="critical">Unknown store</Badge>
                )}
              </InlineStack>

              <Text as="p" variant="bodyMd">
                Finds customers on <strong>{shop}</strong> carrying a loyalty tag
                for this region and writes the matching tier into the{" "}
                <code>custom.loyalty_tier</code> metafield. Customers without a
                tier tag are left untouched.
              </Text>

              {region ? (
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Tags checked for this store:
                  </Text>
                  <List type="bullet">
                    {tags.map((t) => (
                      <List.Item key={t}>
                        <code>{t}</code>
                      </List.Item>
                    ))}
                  </List>
                </BlockStack>
              ) : (
                <Text as="p" variant="bodyMd" tone="critical">
                  This shop isn&apos;t mapped to a region (au/uk/us/eu). Add it to
                  <code> SHOP_REGION</code> in
                  <code> app/lib/loyaltyTierSync.server.js</code>.
                </Text>
              )}

              <InlineStack gap="200">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="preview" />
                  <Button
                    submit
                    disabled={!region}
                    loading={submitting && submittingIntent === "preview"}
                  >
                    Preview (no changes)
                  </Button>
                </fetcher.Form>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="sync" />
                  <Button
                    variant="primary"
                    submit
                    disabled={!region}
                    loading={submitting && submittingIntent === "sync"}
                  >
                    Run sync
                  </Button>
                </fetcher.Form>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {data && !data.ok ? (
          <Layout.Section>
            <Card>
              <Box padding="300" background="bg-surface-critical" borderRadius="200">
                <Text as="pre" variant="bodySm">
                  {data.error}
                </Text>
              </Box>
            </Card>
          </Layout.Section>
        ) : null}

        {result ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    {result.dryRun ? "Preview result" : "Sync result"}
                  </Text>
                  {result.dryRun ? <Badge>Dry run</Badge> : <Badge tone="success">Applied</Badge>}
                </InlineStack>

                <List type="bullet">
                  {result.perTier.map((t) => (
                    <List.Item key={t.tag}>
                      <code>{t.tag}</code> &rarr; <strong>{t.value}</strong>:{" "}
                      {t.matched} customer(s)
                    </List.Item>
                  ))}
                </List>

                <Text as="p" variant="bodyMd">
                  {result.customersMatched} tagged customer(s) &middot;{" "}
                  {result.alreadyCorrect} already correct &middot;{" "}
                  {result.dryRun
                    ? `${result.toUpdate} would be updated`
                    : `${result.updated} updated`}
                  {result.conflicts
                    ? ` · ${result.conflicts} multi-tier conflict(s)`
                    : ""}
                </Text>

                {result.errors?.length ? (
                  <Box padding="300" background="bg-surface-critical" borderRadius="200">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="critical">
                        {result.errors.length} error(s):
                      </Text>
                      <Text as="pre" variant="bodySm">
                        {result.errors.join("\n")}
                      </Text>
                    </BlockStack>
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
