import { useState } from "react";
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
  Link,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listBannerStatus,
  applyEmailBannerEverywhere,
} from "../lib/emailBanner.server";

const LIQUID_SNIPPET = `{%- assign image_banner_url = shop.metafields.email.banner_url -%}`;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const stores = await listBannerStatus();
  return json({ currentShop: session.shop, stores });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const url = String(formData.get("url") || "").trim();

  if (!/^https:\/\/.+/.test(url)) {
    return json(
      { ok: false, error: "Enter a full image URL starting with https://" },
      { status: 400 },
    );
  }

  try {
    const results = await applyEmailBannerEverywhere(url);
    return json({ ok: results.every((r) => r.ok), url, results });
  } catch (err) {
    return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
};

export default function EmailBannerPage() {
  const { currentShop, stores } = useLoaderData();
  const fetcher = useFetcher();
  const saving = fetcher.state !== "idle";
  const data = fetcher.data;

  const current = stores.find((s) => s.shop === currentShop);
  const [url, setUrl] = useState(current?.url || "");
  const previewUrl = /^https:\/\/.+/.test(url) ? url : "";

  return (
    <Page>
      <TitleBar title="Email banner" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Update email banner
              </Text>
              <Text as="p" variant="bodyMd">
                Paste the CDN URL of the new campaign banner (upload it to
                Shopify Files first, e.g. via the Asset uploader). Saving writes
                the <code>email.banner_url</code> shop metafield on every store,
                so all notification email templates in all regions pick it up
                immediately. Use a freshly uploaded file each week so email
                clients can&apos;t serve a cached copy of the old banner.
              </Text>

              <fetcher.Form method="post">
                <BlockStack gap="300">
                  <TextField
                    label="Banner image URL"
                    name="url"
                    value={url}
                    onChange={setUrl}
                    autoComplete="off"
                    placeholder="https://cdn.shopify.com/s/files/.../email-banner.jpg?v=..."
                    helpText="Must be a full https:// URL."
                  />
                  <InlineStack>
                    <Button variant="primary" submit loading={saving} disabled={!url}>
                      Apply to all stores
                    </Button>
                  </InlineStack>
                </BlockStack>
              </fetcher.Form>

              {previewUrl ? (
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Preview:
                  </Text>
                  <Box borderColor="border" borderWidth="025" borderRadius="200" padding="200">
                    <img
                      src={previewUrl}
                      alt="Email banner preview"
                      style={{ maxWidth: "100%", display: "block" }}
                    />
                  </Box>
                </BlockStack>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        {data && !data.ok && data.error ? (
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

        {data?.results ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    Save result
                  </Text>
                  {data.ok ? (
                    <Badge tone="success">All stores updated</Badge>
                  ) : (
                    <Badge tone="critical">Some stores failed</Badge>
                  )}
                </InlineStack>
                <BlockStack gap="100">
                  {data.results.map((r) => (
                    <InlineStack key={r.shop} gap="200" blockAlign="center">
                      {r.ok ? (
                        <Badge tone="success">Updated</Badge>
                      ) : (
                        <Badge tone="critical">Failed</Badge>
                      )}
                      <Text as="span" variant="bodySm">
                        {r.shop}
                        {r.error ? ` - ${r.error}` : ""}
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Current value per store
              </Text>
              <BlockStack gap="200">
                {stores.map((s) => (
                  <InlineStack key={s.shop} gap="200" blockAlign="center" wrap={false}>
                    <Box minWidth="180px">
                      <Text as="span" variant="bodyMd">
                        {s.flag} {s.name || s.shop}
                      </Text>
                    </Box>
                    {s.region ? <Badge>{s.region}</Badge> : null}
                    {!s.reachable ? (
                      <Badge tone="critical">Unreachable</Badge>
                    ) : s.url ? (
                      <Link url={s.url} target="_blank">
                        <Text as="span" variant="bodySm" breakWord>
                          {s.url}
                        </Text>
                      </Link>
                    ) : (
                      <Badge tone="attention">Not set</Badge>
                    )}
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                One-time template change
              </Text>
              <Text as="p" variant="bodyMd">
                Replace the hardcoded assign at the top of each notification
                email template with:
              </Text>
              <Box
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
                overflowX="scroll"
              >
                <Text as="pre" variant="bodySm">
                  {LIQUID_SNIPPET}
                </Text>
              </Box>
              <Text as="p" variant="bodyMd">
                After that, templates never need editing for a campaign change.
                Only the metafield is updated from this page.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
