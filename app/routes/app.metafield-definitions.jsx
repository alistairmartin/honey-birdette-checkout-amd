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
import { getAllStatus, installGroup } from "../lib/metafieldDefinitions.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    const groups = await getAllStatus(admin);
    return json({ groups, loaderError: null });
  } catch (err) {
    return json({ groups: [], loaderError: err?.message ?? String(err) });
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const groupId = formData.get("groupId");

  try {
    if (intent === "install") {
      const result = await installGroup(admin, groupId);
      return json({ ok: result.ok, groupId, results: result.results, error: result.error ?? null });
    }
    return json({ ok: false, groupId, error: `Unknown intent: ${intent}` }, { status: 400 });
  } catch (err) {
    return json({ ok: false, groupId, error: err?.message ?? String(err) }, { status: 500 });
  }
};

export default function MetafieldDefinitionsPage() {
  const { groups, loaderError } = useLoaderData();
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  const submittingGroup = fetcher.formData?.get("groupId");
  const result = fetcher.data;

  return (
    <Page>
      <TitleBar title="Metafield definitions" />
      <Layout>
        <Layout.Section>
          <Text as="p" variant="bodyMd" tone="subdued">
            Install the store-owned metafield definitions each feature needs. Buttons
            are safe to click repeatedly — existing definitions are left untouched.
          </Text>
        </Layout.Section>

        {loaderError && (
          <Layout.Section>
            <Card>
              <Text as="p" tone="critical">
                Couldn't load definition status: {loaderError}
              </Text>
            </Card>
          </Layout.Section>
        )}

        {groups.map((group) => {
          const complete = group.installedCount === group.total;
          const isSubmitting = submitting && submittingGroup === group.id;
          const groupResult =
            result && result.groupId === group.id ? result : null;

          return (
            <Layout.Section key={group.id}>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center" gap="300">
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h2" variant="headingMd">
                          {group.title}
                        </Text>
                        {complete ? (
                          <Badge tone="success">Installed</Badge>
                        ) : (
                          <Badge tone="attention">
                            {`${group.installedCount}/${group.total} installed`}
                          </Badge>
                        )}
                      </InlineStack>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        {group.description}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {`${group.ownerType.toLowerCase()} · namespace "${group.namespace}"`}
                      </Text>
                    </BlockStack>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="install" />
                      <input type="hidden" name="groupId" value={group.id} />
                      <Button
                        submit
                        variant="primary"
                        loading={isSubmitting}
                        disabled={submitting}
                      >
                        {complete ? "Re-check / install" : "Install metafields"}
                      </Button>
                    </fetcher.Form>
                  </InlineStack>

                  <Box
                    background="bg-surface-secondary"
                    padding="300"
                    borderRadius="200"
                  >
                    <List type="bullet">
                      {group.definitions.map((def) => (
                        <List.Item key={def.key}>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight="medium">
                              {`${group.namespace}.${def.key}`}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {def.type}
                            </Text>
                            {def.installed ? (
                              <Badge tone="success" size="small">
                                Exists
                              </Badge>
                            ) : (
                              <Badge size="small">Missing</Badge>
                            )}
                          </InlineStack>
                        </List.Item>
                      ))}
                    </List>
                  </Box>

                  {groupResult && (
                    <Box
                      background={
                        groupResult.ok
                          ? "bg-surface-secondary"
                          : "bg-surface-critical"
                      }
                      padding="300"
                      borderRadius="200"
                    >
                      <BlockStack gap="100">
                        <Text as="p" variant="bodyMd" fontWeight="medium">
                          {groupResult.ok
                            ? "All definitions are in place."
                            : "Some definitions failed to install."}
                        </Text>
                        {groupResult.error && (
                          <Text as="p" tone="critical">
                            {groupResult.error}
                          </Text>
                        )}
                        {Array.isArray(groupResult.results) &&
                          groupResult.results.map((r) => (
                            <Text
                              as="p"
                              variant="bodySm"
                              tone={r.status === "error" ? "critical" : "subdued"}
                              key={r.key}
                            >
                              {`${r.key}: ${r.status}${r.message ? ` — ${r.message}` : ""}`}
                            </Text>
                          ))}
                      </BlockStack>
                    </Box>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          );
        })}
      </Layout>
    </Page>
  );
}
