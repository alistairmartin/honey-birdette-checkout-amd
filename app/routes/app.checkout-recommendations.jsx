import { useCallback, useEffect, useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  InlineStack,
  Badge,
  TextField,
  Select,
  Checkbox,
  FormLayout,
  Divider,
  Thumbnail,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { readConfig, saveConfig } from "../lib/checkoutRecommendations.server";
import {
  SUPPORTED_CURRENCIES,
  MANUAL_UPSELL_SLOTS,
  BASE_METAOBJECT_TYPE,
  DEFAULT_HEADING,
  DEFAULT_MAX_PRODUCTS,
} from "../lib/checkoutRecommendations.shared";

// Checkout Recommendations: a single settings object stored in the shop
// metafield $app:checkout-recommendations / config and read by the
// checkout-recommendations extension. Base recommendations come from the
// mini_cart_recommendations metaobjects; this page owns the migrated block
// settings plus the extra rules (free-shipping gap-fill today; loyalty and
// promo to follow).

function formatMoney(amount, currencyCode) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: currencyCode || "AUD",
    }).format(n);
  } catch {
    return `${currencyCode} ${n.toFixed(2)}`;
  }
}

const VARIANT_INFO_QUERY = `#graphql
  query CheckoutRecsVariantInfo($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        image { url altText }
        price
        product {
          title
          featuredImage { url altText }
        }
      }
    }
  }
`;

// All variant gids referenced anywhere in the config, for thumbnail enrichment.
function collectVariantGids(config) {
  const gids = new Set(config.manual_upsells ?? []);
  for (const code of SUPPORTED_CURRENCIES) {
    for (const gid of config.gap_fill?.products?.[code] ?? []) gids.add(gid);
  }
  return Array.from(gids);
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const config = await readConfig(admin);

  const variantInfo = {};
  const gids = collectVariantGids(config);
  if (gids.length > 0) {
    try {
      const response = await admin.graphql(VARIANT_INFO_QUERY, { variables: { ids: gids } });
      const data = await response.json();
      for (const node of data.data?.nodes ?? []) {
        if (!node?.id) continue;
        const image = node.image ?? node.product?.featuredImage ?? null;
        const variantLabel =
          node.title && node.title !== "Default Title" ? ` - ${node.title}` : "";
        variantInfo[node.id] = {
          title: `${node.product?.title ?? "Product"}${variantLabel}`,
          imageUrl: image?.url ?? null,
          altText: image?.altText ?? null,
          price: node.price != null ? formatMoney(node.price) : null,
        };
      }
    } catch (err) {
      console.error("Failed to fetch checkout-recommendations variant info", err);
    }
  }

  return json({ config, variantInfo });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const configJson = String(formData.get("configJson") ?? "").trim();
  if (!configJson) return json({ ok: false, error: "Missing config." });

  let parsed;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return json({ ok: false, error: "Config is not valid JSON." });
  }

  try {
    await saveConfig(admin, parsed);
  } catch (err) {
    console.error("Failed to save checkout-recommendations config", err);
    return json({ ok: false, error: err.message ?? "Save failed." });
  }
  return json({ ok: true });
};

// --------------------------------------------------------------------------
// Builder state <-> config
// --------------------------------------------------------------------------

function emptyFreeShipping() {
  return SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = { standard: "", express: "" };
    return acc;
  }, {});
}

function emptyGapWithin() {
  return SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = "";
    return acc;
  }, {});
}

function emptyGapProducts() {
  return SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = [];
    return acc;
  }, {});
}

// Build the builder state from a stored config + variantInfo (for display).
function builderFromConfig(config, variantInfo) {
  const decorate = (gid) => ({
    variantGid: gid,
    title: variantInfo[gid]?.title ?? "",
    imageUrl: variantInfo[gid]?.imageUrl ?? "",
    price: variantInfo[gid]?.price ?? "",
  });

  const freeShipping = emptyFreeShipping();
  for (const code of SUPPORTED_CURRENCIES) {
    const entry = config.free_shipping?.[code] ?? {};
    freeShipping[code] = {
      standard: entry.standard != null ? String(entry.standard) : "",
      express: entry.express != null ? String(entry.express) : "",
    };
  }

  const within = emptyGapWithin();
  const products = emptyGapProducts();
  for (const code of SUPPORTED_CURRENCIES) {
    const w = config.gap_fill?.within?.[code];
    within[code] = w != null ? String(w) : "";
    products[code] = (config.gap_fill?.products?.[code] ?? []).map(decorate);
  }

  return {
    heading: config.heading ?? DEFAULT_HEADING,
    max_products: config.max_products != null ? String(config.max_products) : String(DEFAULT_MAX_PRODUCTS),
    manual_upsells: (config.manual_upsells ?? []).map(decorate),
    free_shipping: freeShipping,
    gap_fill: {
      enabled: config.gap_fill?.enabled !== false,
      currency: "AUD",
      within,
      products,
    },
  };
}

// Build the config object to persist (display fields stripped; server normalizes).
function configFromBuilder(state) {
  const free_shipping = {};
  for (const code of SUPPORTED_CURRENCIES) {
    const entry = state.free_shipping[code] ?? {};
    const out = {};
    if (entry.standard !== "") out.standard = Number(entry.standard);
    if (entry.express !== "") out.express = Number(entry.express);
    if (Object.keys(out).length) free_shipping[code] = out;
  }

  const within = {};
  const products = {};
  for (const code of SUPPORTED_CURRENCIES) {
    if (state.gap_fill.within[code] !== "") within[code] = Number(state.gap_fill.within[code]);
    const list = (state.gap_fill.products[code] ?? []).map((p) => p.variantGid).filter(Boolean);
    if (list.length) products[code] = list;
  }

  return {
    heading: state.heading.trim() || DEFAULT_HEADING,
    max_products: Number(state.max_products) || DEFAULT_MAX_PRODUCTS,
    manual_upsells: state.manual_upsells.map((p) => p.variantGid).filter(Boolean),
    free_shipping,
    gap_fill: { enabled: state.gap_fill.enabled, within, products },
  };
}

// Map a resourcePicker product selection to our display shape, using the first
// (default) variant - the same variant the extension prices and adds.
function productToVariantPick(product) {
  const variant = product?.variants?.[0];
  if (!variant?.id) return null;
  const image =
    variant.image?.originalSrc ||
    variant.image?.src ||
    product.images?.[0]?.originalSrc ||
    product.images?.[0]?.src ||
    product.images?.[0]?.url ||
    "";
  const rawPrice = typeof variant.price === "string" ? variant.price : variant.price?.amount;
  const variantLabel =
    variant.title && variant.title !== "Default Title" ? ` - ${variant.title}` : "";
  return {
    variantGid: variant.id,
    title: `${product.title}${variantLabel}`,
    imageUrl: image,
    price: rawPrice ? `$${Number(rawPrice).toFixed(2)}` : "",
  };
}

function PickedProductRow({ pick, onRemove }) {
  return (
    <InlineStack gap="300" blockAlign="center" wrap={false}>
      {pick.imageUrl ? (
        <Thumbnail source={pick.imageUrl} alt={pick.title || "Product"} size="small" />
      ) : null}
      <BlockStack gap="050">
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {pick.title || pick.variantGid}
        </Text>
        {pick.price ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {pick.price}
          </Text>
        ) : null}
      </BlockStack>
      <Button variant="tertiary" tone="critical" onClick={onRemove}>
        Remove
      </Button>
    </InlineStack>
  );
}

export default function CheckoutRecommendationsPage() {
  const { config, variantInfo } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  const [builder, setBuilder] = useState(() => builderFromConfig(config, variantInfo));

  const isSaving = fetcher.state === "submitting" || fetcher.state === "loading";
  const lastResult = fetcher.data;

  useEffect(() => {
    if (!lastResult) return;
    if (lastResult.ok) shopify.toast.show("Saved and pushed to checkout");
    else if (lastResult.error) shopify.toast.show(lastResult.error, { isError: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResult]);

  const update = (key, value) => setBuilder((prev) => ({ ...prev, [key]: value }));

  const updateFreeShipping = (code, tier, value) =>
    setBuilder((prev) => ({
      ...prev,
      free_shipping: {
        ...prev.free_shipping,
        [code]: { ...prev.free_shipping[code], [tier]: value },
      },
    }));

  const updateGapWithin = (code, value) =>
    setBuilder((prev) => ({
      ...prev,
      gap_fill: { ...prev.gap_fill, within: { ...prev.gap_fill.within, [code]: value } },
    }));

  const setGapCurrency = (code) =>
    setBuilder((prev) => ({ ...prev, gap_fill: { ...prev.gap_fill, currency: code } }));

  const setGapEnabled = (value) =>
    setBuilder((prev) => ({ ...prev, gap_fill: { ...prev.gap_fill, enabled: value } }));

  // ---- Manual upsells ----
  const addManualUpsell = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: MANUAL_UPSELL_SLOTS - builder.manual_upsells.length,
      action: "select",
      filter: { variants: true, archived: false },
    });
    if (!selection?.length) return;
    const picks = selection.map(productToVariantPick).filter(Boolean);
    setBuilder((prev) => {
      const existing = new Set(prev.manual_upsells.map((p) => p.variantGid));
      const merged = [...prev.manual_upsells];
      for (const p of picks) {
        if (!existing.has(p.variantGid) && merged.length < MANUAL_UPSELL_SLOTS) merged.push(p);
      }
      return { ...prev, manual_upsells: merged };
    });
  }, [shopify, builder.manual_upsells.length]);

  const removeManualUpsell = (gid) =>
    setBuilder((prev) => ({
      ...prev,
      manual_upsells: prev.manual_upsells.filter((p) => p.variantGid !== gid),
    }));

  // ---- Gap-fill products (per currency) ----
  const addGapProduct = useCallback(async () => {
    const code = builder.gap_fill.currency;
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      filter: { variants: true, archived: false },
    });
    if (!selection?.length) return;
    const picks = selection.map(productToVariantPick).filter(Boolean);
    setBuilder((prev) => {
      const current = prev.gap_fill.products[code] ?? [];
      const existing = new Set(current.map((p) => p.variantGid));
      const merged = [...current];
      for (const p of picks) if (!existing.has(p.variantGid)) merged.push(p);
      return {
        ...prev,
        gap_fill: { ...prev.gap_fill, products: { ...prev.gap_fill.products, [code]: merged } },
      };
    });
  }, [shopify, builder.gap_fill.currency]);

  const removeGapProduct = (code, gid) =>
    setBuilder((prev) => ({
      ...prev,
      gap_fill: {
        ...prev.gap_fill,
        products: {
          ...prev.gap_fill.products,
          [code]: (prev.gap_fill.products[code] ?? []).filter((p) => p.variantGid !== gid),
        },
      },
    }));

  const generatedConfig = useMemo(() => configFromBuilder(builder), [builder]);

  const save = () => {
    const formData = new FormData();
    formData.set("configJson", JSON.stringify(generatedConfig));
    fetcher.submit(formData, { method: "POST" });
  };

  const gapCurrency = builder.gap_fill.currency;
  const gapProductsForCurrency = builder.gap_fill.products[gapCurrency] ?? [];

  return (
    <Page>
      <TitleBar title="Checkout Recommendations" />
      <BlockStack gap="500">
        <Banner tone="info">
          <p>
            Base recommendations come from your <b>{BASE_METAOBJECT_TYPE}</b> metaobjects (the same
            source as the theme mini-cart). The settings and rules below layer on top of that and are
            read by the checkout-recommendations extension.
          </p>
        </Banner>

        <Layout>
          <Layout.Section>
            <BlockStack gap="500">
              {/* General */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    General
                  </Text>
                  <FormLayout>
                    <TextField
                      label="Heading"
                      value={builder.heading}
                      onChange={(v) => update("heading", v)}
                      autoComplete="off"
                      placeholder={DEFAULT_HEADING}
                      helpText="Shown above the recommendations in checkout."
                    />
                    <TextField
                      label="Maximum products"
                      type="number"
                      min={1}
                      value={builder.max_products}
                      onChange={(v) => update("max_products", v)}
                      autoComplete="off"
                      helpText={`Maximum number of recommendations to show (defaults to ${DEFAULT_MAX_PRODUCTS}).`}
                    />
                  </FormLayout>
                </BlockStack>
              </Card>

              {/* Manual upsells */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Manual upsells
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Up to {MANUAL_UPSELL_SLOTS} products shown first, before the metaobject and
                    Shopify recommendations. The first (default) variant is added to cart.
                  </Text>
                  <BlockStack gap="300">
                    {builder.manual_upsells.map((pick) => (
                      <PickedProductRow
                        key={pick.variantGid}
                        pick={pick}
                        onRemove={() => removeManualUpsell(pick.variantGid)}
                      />
                    ))}
                  </BlockStack>
                  <InlineStack>
                    <Button
                      onClick={addManualUpsell}
                      disabled={builder.manual_upsells.length >= MANUAL_UPSELL_SLOTS}
                    >
                      Add product
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* Free shipping thresholds */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Free shipping thresholds
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Cart total needed for free standard / Express shipping per currency. Leave a
                    currency blank to hide the shipping nudge for it.
                  </Text>
                  <BlockStack gap="300">
                    {SUPPORTED_CURRENCIES.map((code) => (
                      <FormLayout key={code}>
                        <FormLayout.Group condensed>
                          <TextField
                            label={`${code} - free standard at`}
                            type="number"
                            value={builder.free_shipping[code].standard}
                            onChange={(v) => updateFreeShipping(code, "standard", v)}
                            autoComplete="off"
                          />
                          <TextField
                            label={`${code} - free Express at`}
                            type="number"
                            value={builder.free_shipping[code].express}
                            onChange={(v) => updateFreeShipping(code, "express", v)}
                            autoComplete="off"
                          />
                        </FormLayout.Group>
                      </FormLayout>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>

              {/* Rule 1: free-shipping gap-fill */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Rule: free-shipping gap-fill
                    </Text>
                    <Badge tone={builder.gap_fill.enabled ? "success" : "attention"}>
                      {builder.gap_fill.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    When a customer is close to the free standard shipping threshold, recommend
                    products priced high enough to tip them over the edge. Curate a product list per
                    currency below; the extension shows the cheapest qualifying products first.
                  </Text>
                  <Checkbox
                    label="Enable gap-fill recommendations"
                    checked={builder.gap_fill.enabled}
                    onChange={setGapEnabled}
                  />
                  <Divider />
                  <Select
                    label="Currency"
                    options={SUPPORTED_CURRENCIES.map((c) => ({ label: c, value: c }))}
                    value={gapCurrency}
                    onChange={setGapCurrency}
                    helpText="Pick the currency to edit. Settings are saved per currency."
                  />
                  <TextField
                    label={`Only show when within (${gapCurrency})`}
                    type="number"
                    value={builder.gap_fill.within[gapCurrency]}
                    onChange={(v) => updateGapWithin(gapCurrency, v)}
                    autoComplete="off"
                    helpText="Show gap-fill products only when the remaining spend to free shipping is at or below this amount. Leave blank to always show when there is a gap."
                  />
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Gap-fill products ({gapCurrency})
                    </Text>
                    {gapProductsForCurrency.length === 0 ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        No products yet for {gapCurrency}.
                      </Text>
                    ) : (
                      gapProductsForCurrency.map((pick) => (
                        <PickedProductRow
                          key={pick.variantGid}
                          pick={pick}
                          onRemove={() => removeGapProduct(gapCurrency, pick.variantGid)}
                        />
                      ))
                    )}
                    <InlineStack>
                      <Button onClick={addGapProduct}>Add product</Button>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>

              {/* Future rules */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Rule: loyalty level-up
                    </Text>
                    <Badge>Coming soon</Badge>
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Recommend products that tip a customer into the next loyalty band. Needs a spend
                    signal beyond tier tags - parked until that data source is confirmed.
                  </Text>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Rule: promo alignment
                    </Text>
                    <Badge>Coming soon</Badge>
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Recommend products that align with a promo already in the cart. Largely covered
                    today by the {BASE_METAOBJECT_TYPE} cart-matching rules; a dedicated builder will
                    follow.
                  </Text>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Save
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Stored per shop and pushed live to checkout on save.
                  </Text>
                  <InlineStack>
                    <Button variant="primary" onClick={save} loading={isSaving}>
                      Save
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Generated JSON
                  </Text>
                  <Box
                    padding="400"
                    background="bg-surface-active"
                    borderWidth="025"
                    borderRadius="200"
                    borderColor="border"
                    overflowX="scroll"
                  >
                    <pre style={{ margin: 0 }}>
                      <code>{JSON.stringify(generatedConfig, null, 2)}</code>
                    </pre>
                  </Box>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
