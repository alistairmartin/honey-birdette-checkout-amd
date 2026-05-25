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
  syncBundleIndexToCartTransform,
} from "../lib/lubricantBundle.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const cartTransformId = await getCartTransformId(admin);
  return json({ cartTransformId });
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
    return json({ ok: false, error: `Unknown intent: ${intent}` }, { status: 400 });
  } catch (err) {
    return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
};

export default function CartTransformPage() {
  const { cartTransformId } = useLoaderData();
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  const lastResult = fetcher.data;

  return (
    <Page>
      <TitleBar title="Cart transform setup" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" align="start" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Lubricant Bundle Transform
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
                <code>lubricant_bundle</code> metaobject changes — but you can
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
                      loading={submitting && fetcher.formData?.get("intent") === "install"}
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
                      loading={submitting && fetcher.formData?.get("intent") === "sync"}
                    >
                      Resync bundle index
                    </Button>
                  </fetcher.Form>
                ) : null}
              </InlineStack>

              {lastResult ? (
                <Box
                  padding="300"
                  background={lastResult.ok ? "bg-surface-success" : "bg-surface-critical"}
                  borderRadius="200"
                >
                  <Text as="pre" variant="bodySm">
                    {JSON.stringify(lastResult, null, 2)}
                  </Text>
                </Box>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
