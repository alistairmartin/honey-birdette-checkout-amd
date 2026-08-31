import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const NAMESPACE = "checkout";
const FIELDS = [
  {
    key: "availableInStore",
    label: "Available in store",
    helpText: "Shown when the item is in stock at the selected boutique.",
    defaultValue: "Available within 3 hours",
  },
  {
    key: "unavailableInStore",
    label: "Unavailable in store",
    helpText:
      "Shown when the item has to be transferred to the selected boutique.",
    defaultValue: "Available within 2 - 5 days",
  },
];

const METAFIELDS_QUERY = `#graphql
  query BoutiquePickupMessages {
    shop {
      id
      availableInStore: metafield(namespace: "${NAMESPACE}", key: "availableInStore") {
        value
      }
      unavailableInStore: metafield(namespace: "${NAMESPACE}", key: "unavailableInStore") {
        value
      }
    }
    metafieldDefinitions(first: 20, ownerType: SHOP, namespace: "${NAMESPACE}") {
      nodes {
        key
      }
    }
  }`;

const DEFINITION_CREATE_MUTATION = `#graphql
  mutation CreateBoutiquePickupDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        key
      }
      userErrors {
        field
        message
      }
    }
  }`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation SetBoutiquePickupMessages($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(METAFIELDS_QUERY);
  const { data } = await response.json();

  const definedKeys = new Set(
    (data?.metafieldDefinitions?.nodes ?? []).map((d) => d.key),
  );

  return json({
    shop: session.shop,
    values: {
      availableInStore: data?.shop?.availableInStore?.value ?? "",
      unavailableInStore: data?.shop?.unavailableInStore?.value ?? "",
    },
    missingDefinitions: FIELDS.filter((f) => !definedKeys.has(f.key)).map(
      (f) => f.key,
    ),
  });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "create-definitions") {
    const missing = String(formData.get("missing") || "")
      .split(",")
      .filter(Boolean);
    const errors = [];
    for (const key of missing) {
      const field = FIELDS.find((f) => f.key === key);
      if (!field) continue;
      const response = await admin.graphql(DEFINITION_CREATE_MUTATION, {
        variables: {
          definition: {
            name: `Boutique pickup - ${field.label.toLowerCase()}`,
            namespace: NAMESPACE,
            key: field.key,
            type: "single_line_text_field",
            ownerType: "SHOP",
          },
        },
      });
      const { data } = await response.json();
      const userErrors = data?.metafieldDefinitionCreate?.userErrors ?? [];
      // TAKEN already exists is fine - the goal is that a definition exists.
      errors.push(
        ...userErrors.filter((e) => !/already exists|taken/i.test(e.message)),
      );
    }
    if (errors.length) {
      return json(
        { ok: false, error: errors.map((e) => e.message).join("; ") },
        { status: 400 },
      );
    }
    return json({ ok: true, createdDefinitions: true });
  }

  const values = {};
  for (const field of FIELDS) {
    values[field.key] = String(formData.get(field.key) ?? "").trim();
  }

  const empty = FIELDS.filter((f) => !values[f.key]);
  if (empty.length) {
    return json(
      {
        ok: false,
        error: `${empty.map((f) => f.label).join(" and ")} can't be empty.`,
      },
      { status: 400 },
    );
  }

  const idResponse = await admin.graphql(`#graphql
    query { shop { id } }`);
  const idData = await idResponse.json();
  const shopId = idData?.data?.shop?.id;
  if (!shopId) {
    return json({ ok: false, error: "Couldn't load the shop id." }, { status: 500 });
  }

  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: FIELDS.map((field) => ({
        ownerId: shopId,
        namespace: NAMESPACE,
        key: field.key,
        type: "single_line_text_field",
        value: values[field.key],
      })),
    },
  });
  const { data } = await response.json();
  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) {
    return json(
      { ok: false, error: userErrors.map((e) => e.message).join("; ") },
      { status: 400 },
    );
  }

  return json({ ok: true, values });
};

export default function BoutiquePickupMessagePage() {
  const { shop, values: savedValues, missingDefinitions } = useLoaderData();
  const fetcher = useFetcher();
  const definitionFetcher = useFetcher();
  const saving = fetcher.state !== "idle";
  const creatingDefinitions = definitionFetcher.state !== "idle";
  const result = fetcher.data;
  const definitionResult = definitionFetcher.data;

  // Prefill empty fields with the standard wording so a first-time setup is
  // one Save away.
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      FIELDS.map((f) => [f.key, savedValues[f.key] || f.defaultValue]),
    ),
  );
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (result?.ok && result.values) {
      setShowSaved(true);
      setValues(result.values);
    }
  }, [result]);

  const dirty = FIELDS.some((f) => values[f.key] !== savedValues[f.key]);

  return (
    <Page narrowWidth>
      <TitleBar title="Boutique pickup message" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Pickup availability wording
              </Text>
              <Text as="p" variant="bodyMd">
                These messages come from the <code>checkout.availableInStore</code>{" "}
                and <code>checkout.unavailableInStore</code> shop metafields on{" "}
                {shop}. Saving updates the wording shown against boutique pickup
                availability at checkout.
              </Text>

              {missingDefinitions.length ? (
                <Banner
                  tone="warning"
                  title="Metafield definitions missing on this store"
                  action={{
                    content: "Create definitions",
                    loading: creatingDefinitions,
                    onAction: () =>
                      definitionFetcher.submit(
                        {
                          intent: "create-definitions",
                          missing: missingDefinitions.join(","),
                        },
                        { method: "post" },
                      ),
                  }}
                >
                  <Text as="p" variant="bodyMd">
                    {missingDefinitions
                      .map((key) => `${NAMESPACE}.${key}`)
                      .join(" and ")}{" "}
                    {missingDefinitions.length === 1 ? "has" : "have"} no
                    definition yet. Create {missingDefinitions.length === 1 ? "it" : "them"}{" "}
                    here, then save the wording below.
                  </Text>
                </Banner>
              ) : null}
              {definitionResult && !definitionResult.ok ? (
                <Banner tone="critical">{definitionResult.error}</Banner>
              ) : null}
              {definitionResult?.createdDefinitions && !creatingDefinitions ? (
                <Banner tone="success">
                  Definitions created. Save the wording below to set the values.
                </Banner>
              ) : null}
              {result && !result.ok ? (
                <Banner tone="critical">{result.error}</Banner>
              ) : null}
              {showSaved && !saving ? (
                <Banner tone="success" onDismiss={() => setShowSaved(false)}>
                  Saved. Checkout picks up the new wording immediately.
                </Banner>
              ) : null}

              <fetcher.Form method="post">
                <BlockStack gap="400">
                  {FIELDS.map((field) => (
                    <TextField
                      key={field.key}
                      label={field.label}
                      name={field.key}
                      value={values[field.key]}
                      onChange={(value) =>
                        setValues((prev) => ({ ...prev, [field.key]: value }))
                      }
                      autoComplete="off"
                      helpText={field.helpText}
                      disabled={saving}
                    />
                  ))}
                  <InlineStack>
                    <Button
                      variant="primary"
                      submit
                      loading={saving}
                      disabled={!dirty}
                    >
                      Save
                    </Button>
                  </InlineStack>
                </BlockStack>
              </fetcher.Form>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
