import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Banner,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const API_VERSIONS = ["2026-01", "2025-10", "2025-07", "2025-04", "unstable"];
const STORAGE_KEY = "amd-graphql-explorer";
const MAX_HISTORY = 20;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return json({ shop: session.shop, scopes: (session.scope ?? "").split(",").filter(Boolean) });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const query = formData.get("query");
  const rawVariables = (formData.get("variables") ?? "").toString().trim();
  const apiVersion = formData.get("apiVersion");

  let variables;
  if (rawVariables) {
    try {
      variables = JSON.parse(rawVariables);
    } catch (err) {
      return json({ ok: false, error: `Variables are not valid JSON: ${err.message}` }, { status: 400 });
    }
  }

  const startedAt = Date.now();
  try {
    const response = await admin.graphql(query, { variables, apiVersion });
    const body = await response.json();
    return json({
      ok: !body.errors,
      body,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    // GraphqlQueryError carries the parsed response body when Shopify returns errors.
    const body = err?.body ?? err?.response?.body ?? null;
    return json(
      {
        ok: false,
        body,
        error: err?.message ?? String(err),
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
};

const SAMPLE = `query ShopName {
  shop {
    name
    myshopifyDomain
  }
}`;

export default function GraphqlExplorerPage() {
  const fetcher = useFetcher();
  const [query, setQuery] = useState(SAMPLE);
  const [variables, setVariables] = useState("");
  const [apiVersion, setApiVersion] = useState(API_VERSIONS[0]);
  const [history, setHistory] = useState([]);

  const running = fetcher.state !== "idle";
  const result = fetcher.data;
  const isMutation = /^\s*mutation\b/m.test(query);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(stored)) setHistory(stored);
    } catch {
      // ignore unreadable history
    }
  }, []);

  const run = () => {
    const entry = { query, variables, apiVersion };
    const next = [entry, ...history.filter((h) => h.query !== query)].slice(0, MAX_HISTORY);
    setHistory(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore quota failures
    }
    fetcher.submit(entry, { method: "POST" });
  };

  const prettifyVariables = () => {
    if (!variables.trim()) return;
    try {
      setVariables(JSON.stringify(JSON.parse(variables), null, 2));
    } catch {
      // leave as-is if it isn't parseable yet
    }
  };

  const output = result?.body ? JSON.stringify(result.body, null, 2) : result?.error ?? "";

  return (
    <Page>
      <TitleBar title="GraphQL explorer" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="warning">
              Runs against the Admin API with this app's access token. Mutations change live
              store data immediately — there is no confirmation step.
            </Banner>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Operation
                    </Text>
                    {isMutation ? <Badge tone="critical">Mutation</Badge> : <Badge>Query</Badge>}
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center">
                    <Box minWidth="140px">
                      <Select
                        label="API version"
                        labelHidden
                        options={API_VERSIONS.map((v) => ({ label: v, value: v }))}
                        value={apiVersion}
                        onChange={setApiVersion}
                      />
                    </Box>
                    <Button variant="primary" loading={running} onClick={run}>
                      Run
                    </Button>
                  </InlineStack>
                </InlineStack>

                <TextField
                  label="Query or mutation"
                  labelHidden
                  value={query}
                  onChange={setQuery}
                  multiline={16}
                  autoComplete="off"
                  monospaced
                />

                <TextField
                  label="Variables (JSON)"
                  value={variables}
                  onChange={setVariables}
                  onBlur={prettifyVariables}
                  multiline={5}
                  autoComplete="off"
                  monospaced
                  placeholder='{ "id": "gid://shopify/Product/123" }'
                />
              </BlockStack>
            </Card>

            {result ? (
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Response
                    </Text>
                    {result.ok ? (
                      <Badge tone="success">Success</Badge>
                    ) : (
                      <Badge tone="critical">Errors</Badge>
                    )}
                    {result.durationMs != null ? (
                      <Text as="span" tone="subdued" variant="bodySm">
                        {result.durationMs} ms
                      </Text>
                    ) : null}
                    <Button
                      variant="plain"
                      onClick={() => navigator.clipboard?.writeText(output)}
                    >
                      Copy
                    </Button>
                  </InlineStack>
                  {result.error && !result.body ? (
                    <Banner tone="critical">{result.error}</Banner>
                  ) : null}
                  <Box
                    background="bg-surface-secondary"
                    padding="300"
                    borderRadius="200"
                    overflowX="scroll"
                  >
                    <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre" }}>{output}</pre>
                  </Box>
                </BlockStack>
              </Card>
            ) : null}

            {history.length ? (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Recent
                  </Text>
                  {history.map((h, i) => (
                    <InlineStack key={i} align="space-between" blockAlign="center" gap="200">
                      <Box overflowX="hidden">
                        <Text as="span" variant="bodySm" truncate>
                          {h.query.split("\n")[0]}
                        </Text>
                      </Box>
                      <Button
                        variant="plain"
                        onClick={() => {
                          setQuery(h.query);
                          setVariables(h.variables ?? "");
                          setApiVersion(h.apiVersion ?? API_VERSIONS[0]);
                        }}
                      >
                        Load
                      </Button>
                    </InlineStack>
                  ))}
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
