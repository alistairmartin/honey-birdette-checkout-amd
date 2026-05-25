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
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getCartTransformId,
  installCartTransform,
  uninstallCartTransform,
  syncBundleIndexToCartTransform,
  verifyBundleDefinition,
  setupOrRepairBundleDefinition,
  inspectBundleIndex,
} from "../lib/lubricantBundle.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const [cartTransformId, definition, bundleIndex] = await Promise.all([
    getCartTransformId(admin),
    verifyBundleDefinition(admin),
    inspectBundleIndex(admin),
  ]);
  return json({ cartTransformId, definition, bundleIndex });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "install") {
      const result = await installCartTransform(admin);
      const sync = await syncBundleIndexToCartTransform(admin);
      return json({ ok: true, intent, result, sync });
    }
    if (intent === "sync") {
      const sync = await syncBundleIndexToCartTransform(admin);
      return json({ ok: true, intent, sync });
    }
    if (intent === "uninstall") {
      const result = await uninstallCartTransform(admin);
      return json({ ok: true, intent, result });
    }
    if (intent === "verifyDefinition") {
      const definition = await verifyBundleDefinition(admin);
      return json({ ok: true, intent, definition });
    }
    if (intent === "setupDefinition") {
      const result = await setupOrRepairBundleDefinition(admin);
      const definition = await verifyBundleDefinition(admin);
      return json({ ok: true, intent, result, definition });
    }
    return json({ ok: false, error: `Unknown intent: ${intent}` }, { status: 400 });
  } catch (err) {
    return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
};

function definitionTone(definition) {
  if (!definition.exists) return "attention";
  if (definition.missing.length || definition.mismatches.length) return "warning";
  return "success";
}

function definitionStatusLabel(definition) {
  if (!definition.exists) return "Not created";
  if (definition.missing.length) return `${definition.missing.length} missing field(s)`;
  if (definition.mismatches.length) return `${definition.mismatches.length} type mismatch(es)`;
  return "Up to date";
}

export default function CartTransformPage() {
  const { cartTransformId, definition, bundleIndex } = useLoaderData();
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  const lastResult = fetcher.data;
  const submittingIntent = fetcher.formData?.get("intent");

  return (
    <Page>
      <TitleBar title="Lubricant bundle setup" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" align="start" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Metaobject definition
                </Text>
                <Badge tone={definitionTone(definition)}>
                  {definitionStatusLabel(definition)}
                </Badge>
              </InlineStack>

              <Text as="p" variant="bodyMd">
                The merchant-owned <code>lubricant_bundle</code> metaobject
                definition holds the bundle structure (products, options,
                parent product, per-currency discount amounts). The app can
                create it or add missing fields, but the merchant retains
                full control to edit or delete it in Content → Metaobjects.
              </Text>

              {definition.exists ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  Definition ID: <code>{definition.definitionId}</code>
                </Text>
              ) : null}

              {definition.missing.length ? (
                <Text as="p" variant="bodyMd" tone="critical">
                  Missing fields: {definition.missing.join(", ")}
                </Text>
              ) : null}

              {definition.mismatches.length ? (
                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" tone="critical">
                    Type mismatches (will NOT be auto-fixed - rename or recreate manually):
                  </Text>
                  {definition.mismatches.map((m) => (
                    <Text key={m.key} as="p" variant="bodySm" tone="subdued">
                      • <code>{m.key}</code>: expected <code>{m.expected}</code>, got <code>{m.actual}</code>
                    </Text>
                  ))}
                </BlockStack>
              ) : null}

              <InlineStack gap="200">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="setupDefinition" />
                  <Button
                    variant="primary"
                    submit
                    loading={submitting && submittingIntent === "setupDefinition"}
                  >
                    {definition.exists ? "Add missing fields" : "Create definition"}
                  </Button>
                </fetcher.Form>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="verifyDefinition" />
                  <Button
                    submit
                    loading={submitting && submittingIntent === "verifyDefinition"}
                  >
                    Re-verify
                  </Button>
                </fetcher.Form>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" align="start" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Cart transform
                </Text>
                {cartTransformId ? (
                  <Badge tone="success">Installed</Badge>
                ) : (
                  <Badge tone="attention">Not installed</Badge>
                )}
              </InlineStack>

              <Text as="p" variant="bodyMd">
                Installs the cart transform function so qualifying lines are
                visually merged under a parent bundle product at checkout.
                Installation is one-time per shop. After install, the bundle
                index is kept in sync automatically whenever a{" "}
                <code>lubricant_bundle</code> metaobject changes - but you can
                also force a manual resync below.
              </Text>

              {cartTransformId ? (
                <Box>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Cart transform ID: <code>{cartTransformId}</code>
                  </Text>
                </Box>
              ) : null}

              <InlineStack gap="200">
                {cartTransformId ? null : (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="install" />
                    <Button
                      variant="primary"
                      submit
                      loading={submitting && submittingIntent === "install"}
                    >
                      Install cart transform
                    </Button>
                  </fetcher.Form>
                )}
                {cartTransformId ? (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="sync" />
                    <Button
                      submit
                      loading={submitting && submittingIntent === "sync"}
                    >
                      Resync bundle index
                    </Button>
                  </fetcher.Form>
                ) : null}
                {cartTransformId ? (
                  <Button
                    tone="critical"
                    loading={submitting && submittingIntent === "uninstall"}
                    onClick={() => {
                      const ok = window.confirm(
                        "Uninstall the cart transform? Carts will stop showing merged bundle lines until re-installed.",
                      );
                      if (ok) {
                        fetcher.submit(
                          { intent: "uninstall" },
                          { method: "post" },
                        );
                      }
                    }}
                  >
                    Uninstall
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {cartTransformId ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" align="start" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Current bundle index (what the function sees)
                  </Text>
                  {bundleIndex?.value ? (
                    <Badge tone="success">
                      {`${bundleIndex.parsed?.bundles?.length ?? 0} bundle(s)`}
                    </Badge>
                  ) : (
                    <Badge tone="critical">Empty</Badge>
                  )}
                </InlineStack>

                {bundleIndex?.updatedAt ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Last written: {bundleIndex.updatedAt}
                  </Text>
                ) : null}

                {!bundleIndex?.value ? (
                  <Text as="p" variant="bodyMd" tone="critical">
                    The cart transform metafield is empty. Click "Resync bundle
                    index" above to populate it from your{" "}
                    <code>lubricant_bundle</code> metaobjects.
                  </Text>
                ) : null}

                {bundleIndex?.parsed?.bundles?.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="critical">
                    Index has zero bundles. Likely cause: no{" "}
                    <code>lubricant_bundle</code> entries have{" "}
                    <code>parent_product</code> set (bundles missing a parent
                    product are skipped from the cart transform index).
                  </Text>
                ) : null}

                {bundleIndex?.parsed ? (
                  <Box
                    padding="300"
                    background="bg-surface-secondary"
                    borderRadius="200"
                  >
                    <Text as="pre" variant="bodySm">
                      {JSON.stringify(bundleIndex.parsed, null, 2)}
                    </Text>
                  </Box>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {lastResult ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Last action result
                </Text>
                <Box
                  padding="300"
                  background={lastResult.ok ? "bg-surface-success" : "bg-surface-critical"}
                  borderRadius="200"
                >
                  <Text as="pre" variant="bodySm">
                    {JSON.stringify(lastResult, null, 2)}
                  </Text>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}
      </Layout>
    </Page>
  );
}
