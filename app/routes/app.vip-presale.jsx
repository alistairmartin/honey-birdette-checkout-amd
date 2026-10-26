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

// Settings for the vip-presale-page customer account extension. Stored as one
// JSON shop metafield ($app.vip_presale, declared in shopify.app.toml with
// storefront read access) that the extension reads via the Storefront API.
const SETTINGS_QUERY = `#graphql
  query VipPresaleSettings {
    shop {
      id
      metafield(namespace: "$app", key: "vip_presale") {
        value
      }
    }
  }`;

const COLLECTION_QUERY = `#graphql
  query VipPresaleCollection($query: String!) {
    collections(first: 1, query: $query) {
      nodes {
        handle
        title
      }
    }
  }`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation SetVipPresaleSettings($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }`;

function parseSettings(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return {
      collectionHandle: String(parsed.collectionHandle || ""),
      percentOff: parsed.percentOff ? String(parsed.percentOff) : "",
    };
  } catch {
    return { collectionHandle: "", percentOff: "" };
  }
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(SETTINGS_QUERY);
  const { data } = await response.json();
  return json({ shop: session.shop, settings: parseSettings(data?.shop?.metafield?.value) });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  // Accept a pasted collection URL as well as a bare handle.
  const collectionHandle = String(formData.get("collectionHandle") ?? "")
    .trim()
    .replace(/^.*\/collections\//, "")
    .replace(/[/?#].*$/, "");
  const percentText = String(formData.get("percentOff") ?? "").trim();
  const percentOff = percentText === "" ? 0 : Number(percentText);

  if (!collectionHandle) {
    return json({ ok: false, error: "Collection can't be empty." }, { status: 400 });
  }
  if (!Number.isFinite(percentOff) || percentOff < 0 || percentOff >= 100) {
    return json({ ok: false, error: "Percent off must be a number from 0 to 99." }, { status: 400 });
  }

  const collectionResponse = await admin.graphql(COLLECTION_QUERY, {
    variables: { query: `handle:${collectionHandle}` },
  });
  const collectionData = await collectionResponse.json();
  const collection = collectionData?.data?.collections?.nodes?.[0];
  if (!collection || collection.handle !== collectionHandle) {
    return json(
      { ok: false, error: `No collection with the handle "${collectionHandle}" on this store.` },
      { status: 400 },
    );
  }

  const idResponse = await admin.graphql(SETTINGS_QUERY);
  const idData = await idResponse.json();
  const shopId = idData?.data?.shop?.id;
  if (!shopId) {
    return json({ ok: false, error: "Couldn't load the shop id." }, { status: 500 });
  }

  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: shopId,
          namespace: "$app",
          key: "vip_presale",
          type: "json",
          value: JSON.stringify({ collectionHandle, percentOff }),
        },
      ],
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

  return json({
    ok: true,
    collectionTitle: collection.title,
    settings: { collectionHandle, percentOff: percentOff ? String(percentOff) : "" },
  });
};

export default function VipPresalePage() {
  const { shop, settings: savedSettings } = useLoaderData();
  const fetcher = useFetcher();
  const saving = fetcher.state !== "idle";
  const result = fetcher.data;

  const [settings, setSettings] = useState(savedSettings);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (result?.ok && result.settings) {
      setShowSaved(true);
      setSettings(result.settings);
    }
  }, [result]);

  const dirty =
    settings.collectionHandle !== savedSettings.collectionHandle ||
    settings.percentOff !== savedSettings.percentOff;

  return (
    <Page narrowWidth>
      <TitleBar title="VIP presale" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                VIP presale page
              </Text>
              <Text as="p" variant="bodyMd">
                The VIP Presale customer account page on {shop} shows the products in
                this collection, with prices reduced by the percent off. The page only
                displays the reduced price: the actual discount comes from the
                automatic discount, so keep its percentage the same as this one.
              </Text>

              {result && !result.ok ? <Banner tone="critical">{result.error}</Banner> : null}
              {showSaved && !saving ? (
                <Banner tone="success" onDismiss={() => setShowSaved(false)}>
                  Saved ({result?.collectionTitle}). The account page picks this up on the next load.
                </Banner>
              ) : null}

              <fetcher.Form method="post">
                <BlockStack gap="400">
                  <TextField
                    label="Collection"
                    name="collectionHandle"
                    value={settings.collectionHandle}
                    onChange={(value) => setSettings((prev) => ({ ...prev, collectionHandle: value }))}
                    autoComplete="off"
                    helpText="Collection handle (e.g. bras) or a storefront collection URL."
                    disabled={saving}
                  />
                  <TextField
                    label="Percent off"
                    name="percentOff"
                    type="number"
                    min={0}
                    max={99}
                    suffix="%"
                    value={settings.percentOff}
                    onChange={(value) => setSettings((prev) => ({ ...prev, percentOff: value }))}
                    autoComplete="off"
                    helpText="Leave empty or 0 to show full prices."
                    disabled={saving}
                  />
                  <InlineStack>
                    <Button variant="primary" submit loading={saving} disabled={!dirty}>
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
