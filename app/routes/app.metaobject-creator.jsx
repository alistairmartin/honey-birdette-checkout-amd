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
  ALL_TYPES,
  getDefinitionsStatus,
  provisionDefinitions,
} from "../lib/metaobjectDefinitions.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    const definitions = await getDefinitionsStatus(admin);

    return json({ definitions, loaderError: null });
  } catch (err) {
    return json({ definitions: [], loaderError: err?.message ?? String(err) });
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    let targets;

    if (intent === "create-all") {
      targets = ALL_TYPES;
    } else if (intent === "create-one") {
      const type = formData.get("type");

      if (!type) {
        return json({ ok: false, error: "Missing type" }, { status: 400 });
      }

      targets = [type];
    } else {
      return json({ ok: false, error: `Unknown intent: ${intent}` }, { status: 400 });
    }

    const results = await provisionDefinitions(admin, targets);

    return json({ ok: true, intent, results });
  } catch (err) {
    return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
};

export default function MetaobjectCreatorPage() {
  const { definitions, loaderError } = useLoaderData();
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  const submittingType = fetcher.formData?.get("type");
  const submittingIntent = fetcher.formData?.get("intent");
  const lastResult = fetcher.data;

  const allExist = definitions.length > 0 && definitions.every((d) => d.exists);

  return (
    <Page>
      <TitleBar title="Metaobject Creator" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Metaobject definitions
              </Text>
              <Text as="p" variant="bodyMd">
                Provision the structured metaobject definitions used by the
                theme into <strong>this</strong> store. Run it once per
                store/region. Definitions that already exist are left untouched,
                so it&apos;s safe to re-run. Definitions are created with
                storefront read access so Liquid and the Storefront API can read
                them.
              </Text>
              <InlineStack gap="200">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="create-all" />
                  <Button
                    variant="primary"
                    submit
                    disabled={allExist}
                    loading={submitting && submittingIntent === "create-all"}
                  >
                    {allExist ? "All definitions exist" : "Create all definitions"}
                  </Button>
                </fetcher.Form>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

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

        {definitions.map((def) => (
          <Layout.Section key={def.type}>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" align="start" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    {def.name}
                  </Text>
                  {def.exists ? (
                    <Badge tone="success">Created</Badge>
                  ) : (
                    <Badge tone="attention">Not created</Badge>
                  )}
                </InlineStack>

                <Text as="p" variant="bodyMd">
                  {def.description}
                </Text>

                <Text as="p" variant="bodySm" tone="subdued">
                  Type: <code>{def.type}</code> &middot; Fields:{" "}
                  <code>{def.fieldKeys.join(", ")}</code>
                  {def.references.length
                    ? ` · References: ${def.references.join(", ")}`
                    : ""}
                </Text>

                {def.exists ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    ID: <code>{def.id}</code>
                  </Text>
                ) : (
                  <InlineStack gap="200">
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="create-one" />
                      <input type="hidden" name="type" value={def.type} />
                      <Button
                        submit
                        loading={
                          submitting &&
                          submittingIntent === "create-one" &&
                          submittingType === def.type
                        }
                      >
                        Create
                      </Button>
                    </fetcher.Form>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        ))}

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
