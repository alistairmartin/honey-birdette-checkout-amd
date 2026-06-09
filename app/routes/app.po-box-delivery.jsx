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
  getStatus,
  installCustomization,
  setEnabled,
  uninstallCustomization,
} from "../lib/poBoxDeliveryCustomization.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    const { functionId, customization } = await getStatus(admin);
    return json({ functionId, customization, loaderError: null });
  } catch (err) {
    return json({
      functionId: null,
      customization: null,
      loaderError: err?.message ?? String(err),
    });
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const id = formData.get("id");

  try {
    if (intent === "install") {
      const result = await installCustomization(admin);
      return json({ ok: true, intent, result });
    }
    if (intent === "enable" || intent === "disable") {
      const result = await setEnabled(admin, id, intent === "enable");
      return json({ ok: true, intent, result });
    }
    if (intent === "uninstall") {
      const deletedId = await uninstallCustomization(admin, id);
      return json({ ok: true, intent, deletedId });
    }
    return json({ ok: false, error: `Unknown intent: ${intent}` }, { status: 400 });
  } catch (err) {
    return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
};

export default function PoBoxDeliveryPage() {
  const { functionId, customization, loaderError } = useLoaderData();
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  const submittingIntent = fetcher.formData?.get("intent");
  const lastResult = fetcher.data;

  const installed = Boolean(customization);
  const enabled = customization?.enabled ?? false;

  return (
    <Page>
      <TitleBar title="PO/AFO/FPO delivery options" />
      <Layout>
        {loaderError ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="critical">
                  Loader error
                </Text>
                <Box padding="300" background="bg-surface-critical" borderRadius="200">
                  <Text as="pre" variant="bodySm">
                    {loaderError}
                  </Text>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" align="start" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Delivery customization
                </Text>
                {installed ? (
                  enabled ? (
                    <Badge tone="success">Installed &amp; enabled</Badge>
                  ) : (
                    <Badge tone="warning">Installed (disabled)</Badge>
                  )
                ) : (
                  <Badge tone="attention">Not installed</Badge>
                )}
              </InlineStack>

              <Text as="p" variant="bodyMd">
                Activates the <code>update-po-apo-fpo-boxes</code> function. For a
                military or PO box destination (detected from address line 1,
                city, or zip) checkout shows only the{" "}
                <strong>PO/AFO/FPO</strong> shipping options; for every other
                address those PO/AFO/FPO options are hidden. The rule is fixed in
                the function, so there is nothing to configure here - just install
                it once.
              </Text>

              {!functionId ? (
                <Text as="p" variant="bodyMd" tone="critical">
                  The delivery customization function wasn&apos;t found. Deploy the
                  extension with <code>shopify app deploy</code>, then reload.
                </Text>
              ) : null}

              {installed ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  Customization ID: <code>{customization.id}</code>
                </Text>
              ) : null}

              <InlineStack gap="200">
                {!installed ? (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="install" />
                    <Button
                      variant="primary"
                      submit
                      disabled={!functionId}
                      loading={submitting && submittingIntent === "install"}
                    >
                      Install &amp; enable
                    </Button>
                  </fetcher.Form>
                ) : (
                  <>
                    <fetcher.Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value={enabled ? "disable" : "enable"}
                      />
                      <input type="hidden" name="id" value={customization.id} />
                      <Button
                        submit
                        loading={
                          submitting &&
                          (submittingIntent === "enable" ||
                            submittingIntent === "disable")
                        }
                      >
                        {enabled ? "Disable" : "Enable"}
                      </Button>
                    </fetcher.Form>
                    <Button
                      tone="critical"
                      loading={submitting && submittingIntent === "uninstall"}
                      onClick={() => {
                        const ok = window.confirm(
                          "Remove this delivery customization? PO/AFO/FPO filtering stops until reinstalled.",
                        );
                        if (ok) {
                          fetcher.submit(
                            { intent: "uninstall", id: customization.id },
                            { method: "post" },
                          );
                        }
                      }}
                    >
                      Uninstall
                    </Button>
                  </>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

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
