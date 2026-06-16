import { useCallback, useEffect, useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  ButtonGroup,
  BlockStack,
  Box,
  InlineStack,
  Badge,
  Tabs,
  TextField,
  Select,
  Checkbox,
  FormLayout,
  Divider,
  Thumbnail,
  Banner,
  EmptyState,
  Modal,
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
  DEFAULT_MOTIVATOR_TEXT,
} from "../lib/checkoutRecommendations.shared";

// Checkout Recommendations: a single settings object stored in the shop
// metafield $app:checkout-recommendations / config and read by the
// checkout-recommendations extension. Base recommendations come from the
// mini_cart_recommendations metaobjects; this page owns the migrated block
// settings (Settings tab) plus the extra rules. Today the live rule is the
// Price Range Motivator (a GWP-style builder + saved list); loyalty and promo
// rules are scaffolded as tabs for later.

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
  for (const m of config.motivators ?? []) {
    for (const gid of m.products ?? []) gids.add(gid);
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
// Helpers (client)
// --------------------------------------------------------------------------

function newId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function decorateProduct(gid, variantInfo) {
  return {
    variantGid: gid,
    title: variantInfo[gid]?.title ?? "",
    imageUrl: variantInfo[gid]?.imageUrl ?? "",
    price: variantInfo[gid]?.price ?? "",
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

const EMPTY_FREE_SHIPPING = () =>
  SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = { standard: "", express: "" };
    return acc;
  }, {});

// Settings (global block settings) state from a stored config.
function settingsFromConfig(config, variantInfo) {
  const freeShipping = EMPTY_FREE_SHIPPING();
  for (const code of SUPPORTED_CURRENCIES) {
    const entry = config.free_shipping?.[code] ?? {};
    freeShipping[code] = {
      standard: entry.standard != null ? String(entry.standard) : "",
      express: entry.express != null ? String(entry.express) : "",
    };
  }
  return {
    heading: config.heading ?? DEFAULT_HEADING,
    max_products:
      config.max_products != null ? String(config.max_products) : String(DEFAULT_MAX_PRODUCTS),
    manual_upsells: (config.manual_upsells ?? []).map((gid) => decorateProduct(gid, variantInfo)),
    free_shipping: freeShipping,
  };
}

// Motivators list state from a stored config (products decorated for display).
function motivatorsFromConfig(config, variantInfo) {
  return (config.motivators ?? []).map((m) => ({
    id: m.id || newId(),
    name: m.name ?? "",
    enabled: m.enabled !== false,
    currency: m.currency ?? "AUD",
    min: m.min != null ? String(m.min) : "",
    max: m.max != null ? String(m.max) : "",
    text: m.text ?? DEFAULT_MOTIVATOR_TEXT,
    products: (m.products ?? []).map((gid) => decorateProduct(gid, variantInfo)),
    updatedAt: m.updatedAt ?? null,
  }));
}

const EMPTY_MOTIVATOR = () => ({
  id: null,
  name: "",
  enabled: true,
  currency: "AUD",
  min: "",
  max: "",
  text: DEFAULT_MOTIVATOR_TEXT,
  products: [],
  updatedAt: null,
});

// Assemble the full config object to persist (display fields stripped; the
// server normalizes/drops anything incomplete).
function buildConfig(settings, motivators) {
  const free_shipping = {};
  for (const code of SUPPORTED_CURRENCIES) {
    const entry = settings.free_shipping[code] ?? {};
    const out = {};
    if (entry.standard !== "") out.standard = Number(entry.standard);
    if (entry.express !== "") out.express = Number(entry.express);
    if (Object.keys(out).length) free_shipping[code] = out;
  }
  return {
    heading: settings.heading.trim() || DEFAULT_HEADING,
    max_products: Number(settings.max_products) || DEFAULT_MAX_PRODUCTS,
    manual_upsells: settings.manual_upsells.map((p) => p.variantGid).filter(Boolean),
    free_shipping,
    motivators: motivators.map((m) => ({
      id: m.id,
      name: m.name.trim(),
      enabled: m.enabled,
      currency: m.currency,
      min: m.min !== "" ? Number(m.min) : undefined,
      max: m.max !== "" ? Number(m.max) : undefined,
      text: m.text.trim() || DEFAULT_MOTIVATOR_TEXT,
      products: m.products.map((p) => p.variantGid).filter(Boolean),
      updatedAt: m.updatedAt || undefined,
    })),
  };
}

function formatTimestamp(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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

// --------------------------------------------------------------------------
// Page
// --------------------------------------------------------------------------

const TABS = [
  { id: "price-range", content: "Price Range Motivator", panelID: "price-range-panel" },
  { id: "loyalty", content: "Loyalty level-up", panelID: "loyalty-panel" },
  { id: "promo", content: "Promo alignment", panelID: "promo-panel" },
  { id: "manual-upsells", content: "Manual upsells", panelID: "manual-upsells-panel" },
  { id: "settings", content: "Settings", panelID: "settings-panel" },
];

export default function CheckoutRecommendationsPage() {
  const { config, variantInfo } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  const [selectedTab, setSelectedTab] = useState(0);
  const [settings, setSettings] = useState(() => settingsFromConfig(config, variantInfo));
  const [motivators, setMotivators] = useState(() => motivatorsFromConfig(config, variantInfo));

  // Price Range Motivator sub-view + builder draft.
  const [motivatorView, setMotivatorView] = useState("saved"); // "saved" | "builder"
  const [draft, setDraft] = useState(EMPTY_MOTIVATOR);
  const [editingId, setEditingId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const isSaving = fetcher.state === "submitting" || fetcher.state === "loading";
  const lastResult = fetcher.data;

  useEffect(() => {
    if (!lastResult) return;
    if (lastResult.ok) shopify.toast.show("Saved and pushed to checkout");
    else if (lastResult.error) shopify.toast.show(lastResult.error, { isError: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResult]);

  // Persist the whole config (settings + the given motivators array).
  const persist = useCallback(
    (nextMotivators, nextSettings = settings) => {
      const formData = new FormData();
      formData.set("configJson", JSON.stringify(buildConfig(nextSettings, nextMotivators)));
      fetcher.submit(formData, { method: "POST" });
    },
    [fetcher, settings],
  );

  // ---- Settings tab ----
  const updateSetting = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));
  const updateFreeShipping = (code, tier, value) =>
    setSettings((prev) => ({
      ...prev,
      free_shipping: {
        ...prev.free_shipping,
        [code]: { ...prev.free_shipping[code], [tier]: value },
      },
    }));

  const addManualUpsell = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: Math.max(1, MANUAL_UPSELL_SLOTS - settings.manual_upsells.length),
      action: "select",
      filter: { variants: true, archived: false },
    });
    if (!selection?.length) return;
    const picks = selection.map(productToVariantPick).filter(Boolean);
    setSettings((prev) => {
      const existing = new Set(prev.manual_upsells.map((p) => p.variantGid));
      const merged = [...prev.manual_upsells];
      for (const p of picks) {
        if (!existing.has(p.variantGid) && merged.length < MANUAL_UPSELL_SLOTS) merged.push(p);
      }
      return { ...prev, manual_upsells: merged };
    });
  }, [shopify, settings.manual_upsells.length]);

  const removeManualUpsell = (gid) =>
    setSettings((prev) => ({
      ...prev,
      manual_upsells: prev.manual_upsells.filter((p) => p.variantGid !== gid),
    }));

  const saveSettings = () => persist(motivators, settings);

  // ---- Motivator builder ----
  const updateDraft = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const addDraftProduct = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      filter: { variants: true, archived: false },
    });
    if (!selection?.length) return;
    const picks = selection.map(productToVariantPick).filter(Boolean);
    setDraft((prev) => {
      const existing = new Set(prev.products.map((p) => p.variantGid));
      const merged = [...prev.products];
      for (const p of picks) if (!existing.has(p.variantGid)) merged.push(p);
      return { ...prev, products: merged };
    });
  }, [shopify]);

  const removeDraftProduct = (gid) =>
    setDraft((prev) => ({ ...prev, products: prev.products.filter((p) => p.variantGid !== gid) }));

  const newMotivator = () => {
    setDraft(EMPTY_MOTIVATOR());
    setEditingId(null);
    setMotivatorView("builder");
  };

  const editMotivator = (m) => {
    setDraft({ ...m });
    setEditingId(m.id);
    setMotivatorView("builder");
  };

  const duplicateMotivator = (m) => {
    setDraft({ ...m, id: null, name: m.name ? `${m.name} (copy)` : "", updatedAt: null });
    setEditingId(null);
    setMotivatorView("builder");
    shopify.toast.show("Duplicated - save to keep the copy");
  };

  const validateDraft = () => {
    if (!draft.name.trim()) return "Add a name for this motivator.";
    if (draft.max === "" || !(Number(draft.max) > 0)) return "Set a positive max range (target).";
    if (draft.min !== "" && Number(draft.min) >= Number(draft.max))
      return "Min range must be below max range.";
    if (draft.products.length === 0) return "Add at least one product.";
    return null;
  };

  const saveMotivator = () => {
    const error = validateDraft();
    if (error) {
      shopify.toast.show(error, { isError: true });
      return;
    }
    const stamped = {
      ...draft,
      id: draft.id || newId(),
      updatedAt: new Date().toISOString(),
    };
    setMotivators((prev) => {
      const exists = prev.some((m) => m.id === stamped.id);
      const next = exists
        ? prev.map((m) => (m.id === stamped.id ? stamped : m))
        : [stamped, ...prev];
      persist(next);
      return next;
    });
    setEditingId(stamped.id);
    setDraft(stamped);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    setMotivators((prev) => {
      const next = prev.filter((m) => m.id !== deleteTarget.id);
      persist(next);
      return next;
    });
    if (editingId === deleteTarget.id) {
      setEditingId(null);
      setDraft(EMPTY_MOTIVATOR());
    }
    setDeleteTarget(null);
  };

  const draftConfigPreview = useMemo(
    () => buildConfig(settings, motivators),
    [settings, motivators],
  );

  return (
    <Page>
      <TitleBar title="Checkout Recommendations" />
      <BlockStack gap="500">
        <Banner tone="info">
          <p>
            Base recommendations come from your <b>{BASE_METAOBJECT_TYPE}</b> metaobjects (the same
            source as the theme mini-cart). The rules and settings below layer on top and are read by
            the checkout-recommendations extension.
          </p>
        </Banner>

        <Card padding="0">
          <Tabs tabs={TABS} selected={selectedTab} onSelect={setSelectedTab} />
        </Card>

        {/* ---- Price Range Motivator ---- */}
        {selectedTab === 0 && (
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Price Range Motivator
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  When a customer&apos;s cart subtotal falls inside a motivator&apos;s range, show a
                  custom message and recommend products priced to tip them over the top of the range
                  (e.g. the free-shipping threshold). Each motivator is per currency, and a currency
                  can have several - for example one for standard free shipping and one for Express.
                </Text>
                <InlineStack>
                  <ButtonGroup variant="segmented">
                    <Button
                      pressed={motivatorView === "saved"}
                      onClick={() => setMotivatorView("saved")}
                    >
                      {`Saved${motivators.length ? ` (${motivators.length})` : ""}`}
                    </Button>
                    <Button
                      pressed={motivatorView === "builder"}
                      onClick={() => setMotivatorView("builder")}
                    >
                      Builder
                    </Button>
                  </ButtonGroup>
                </InlineStack>
              </BlockStack>
            </Card>

            {motivatorView === "saved" && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      Saved motivators
                    </Text>
                    <Button onClick={newMotivator}>New motivator</Button>
                  </InlineStack>
                  {motivators.length === 0 ? (
                    <EmptyState
                      heading="No motivators yet"
                      action={{ content: "Open builder", onAction: newMotivator }}
                      image=""
                    >
                      <p>Build a motivator, give it a name, and save it. It goes live in checkout.</p>
                    </EmptyState>
                  ) : (
                    <BlockStack gap="300">
                      {motivators.map((m) => (
                        <Card key={m.id}>
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <InlineStack gap="200" blockAlign="center">
                                <Text as="h3" variant="headingSm">
                                  {m.name || "Untitled motivator"}
                                </Text>
                                <Badge tone="info">{m.currency}</Badge>
                                <Badge tone={m.enabled ? "success" : "attention"}>
                                  {m.enabled ? "Enabled" : "Disabled"}
                                </Badge>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {`${m.min || 0}-${m.max || "?"} - ${m.products.length} product${
                                    m.products.length === 1 ? "" : "s"
                                  }`}
                                </Text>
                              </InlineStack>
                              {m.updatedAt ? (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  Updated {formatTimestamp(m.updatedAt)}
                                </Text>
                              ) : null}
                            </InlineStack>
                            <InlineStack gap="200">
                              <Button onClick={() => editMotivator(m)}>Edit</Button>
                              <Button onClick={() => duplicateMotivator(m)}>Duplicate</Button>
                              <Button
                                tone="critical"
                                variant="tertiary"
                                onClick={() => setDeleteTarget(m)}
                              >
                                Delete
                              </Button>
                            </InlineStack>
                          </BlockStack>
                        </Card>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {motivatorView === "builder" && (
              <Layout>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingSm">
                          {editingId ? "Edit motivator" : "Build a motivator"}
                        </Text>
                        {editingId ? <Badge tone="info">Editing saved</Badge> : null}
                      </InlineStack>
                      <FormLayout>
                        <TextField
                          label="Name"
                          value={draft.name}
                          onChange={(v) => updateDraft("name", v)}
                          autoComplete="off"
                          placeholder="e.g. AUD - free standard shipping"
                          helpText="Internal label so you can find this motivator in Saved."
                        />
                        <Checkbox
                          label="Enabled"
                          checked={draft.enabled}
                          onChange={(v) => updateDraft("enabled", v)}
                        />
                        <Select
                          label="Currency"
                          options={SUPPORTED_CURRENCIES.map((c) => ({ label: c, value: c }))}
                          value={draft.currency}
                          onChange={(v) => updateDraft("currency", v)}
                          helpText="The motivator only runs when checkout is in this currency."
                        />
                        <FormLayout.Group>
                          <TextField
                            label={`Min range (${draft.currency})`}
                            type="number"
                            value={draft.min}
                            onChange={(v) => updateDraft("min", v)}
                            autoComplete="off"
                            helpText="Start showing once the cart subtotal reaches this. Blank = from $0."
                          />
                          <TextField
                            label={`Max range (${draft.currency})`}
                            type="number"
                            value={draft.max}
                            onChange={(v) => updateDraft("max", v)}
                            autoComplete="off"
                            helpText="The target (e.g. free-shipping threshold). Stops showing once the subtotal reaches it."
                          />
                        </FormLayout.Group>
                        <TextField
                          label="Message"
                          value={draft.text}
                          onChange={(v) => updateDraft("text", v)}
                          autoComplete="off"
                          multiline={2}
                          helpText="Shown above the recommendations while in range. Use {{ remaining }} for the spend left to reach the max."
                        />
                        <Divider />
                        <Text as="h3" variant="headingSm">
                          Products
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          The extension shows the cheapest of these priced at or above the remaining
                          spend, so adding one tips the customer over the max.
                        </Text>
                        <BlockStack gap="300">
                          {draft.products.length === 0 ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              No products yet.
                            </Text>
                          ) : (
                            draft.products.map((pick) => (
                              <PickedProductRow
                                key={pick.variantGid}
                                pick={pick}
                                onRemove={() => removeDraftProduct(pick.variantGid)}
                              />
                            ))
                          )}
                          <InlineStack>
                            <Button onClick={addDraftProduct}>Add product</Button>
                          </InlineStack>
                        </BlockStack>
                        <Divider />
                        <InlineStack gap="200">
                          <Button variant="primary" onClick={saveMotivator} loading={isSaving}>
                            {editingId ? "Update motivator" : "Save motivator"}
                          </Button>
                          <Button onClick={() => setMotivatorView("saved")}>Back to saved</Button>
                        </InlineStack>
                      </FormLayout>
                    </BlockStack>
                  </Card>
                </Layout.Section>
              </Layout>
            )}
          </BlockStack>
        )}

        {/* ---- Loyalty (coming soon) ---- */}
        {selectedTab === 1 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Loyalty level-up
                </Text>
                <Badge>Coming soon</Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                Recommend products that tip a customer into the next loyalty band. Needs a spend
                signal beyond tier tags - parked until that data source is confirmed.
              </Text>
            </BlockStack>
          </Card>
        )}

        {/* ---- Promo (coming soon) ---- */}
        {selectedTab === 2 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Promo alignment
                </Text>
                <Badge>Coming soon</Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                Recommend products that align with a promo already in the cart. Largely covered today
                by the {BASE_METAOBJECT_TYPE} cart-matching rules; a dedicated builder will follow.
              </Text>
            </BlockStack>
          </Card>
        )}

        {/* ---- Manual upsells ---- */}
        {selectedTab === 3 && (
          <Layout>
            <Layout.Section>
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Manual upsells
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Up to {MANUAL_UPSELL_SLOTS} products shown before the metaobject and Shopify
                      recommendations. The first (default) variant is added to cart.
                    </Text>
                    <BlockStack gap="300">
                      {settings.manual_upsells.map((pick) => (
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
                        disabled={settings.manual_upsells.length >= MANUAL_UPSELL_SLOTS}
                      >
                        Add product
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>

                <InlineStack>
                  <Button variant="primary" onClick={saveSettings} loading={isSaving}>
                    Save
                  </Button>
                </InlineStack>
              </BlockStack>
            </Layout.Section>
          </Layout>
        )}

        {/* ---- Settings ---- */}
        {selectedTab === 4 && (
          <Layout>
            <Layout.Section>
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      General
                    </Text>
                    <FormLayout>
                      <TextField
                        label="Heading"
                        value={settings.heading}
                        onChange={(v) => updateSetting("heading", v)}
                        autoComplete="off"
                        placeholder={DEFAULT_HEADING}
                        helpText="Shown above the recommendations in checkout."
                      />
                      <TextField
                        label="Maximum products"
                        type="number"
                        min={1}
                        value={settings.max_products}
                        onChange={(v) => updateSetting("max_products", v)}
                        autoComplete="off"
                        helpText={`Maximum number of recommendations to show (defaults to ${DEFAULT_MAX_PRODUCTS}).`}
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Free shipping thresholds
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Drives the fallback shipping nudge in the header per currency. Leave a currency
                      blank to hide it. (Motivators use their own per-currency ranges.)
                    </Text>
                    <BlockStack gap="300">
                      {SUPPORTED_CURRENCIES.map((code) => (
                        <FormLayout key={code}>
                          <FormLayout.Group condensed>
                            <TextField
                              label={`${code} - free standard at`}
                              type="number"
                              value={settings.free_shipping[code].standard}
                              onChange={(v) => updateFreeShipping(code, "standard", v)}
                              autoComplete="off"
                            />
                            <TextField
                              label={`${code} - free Express at`}
                              type="number"
                              value={settings.free_shipping[code].express}
                              onChange={(v) => updateFreeShipping(code, "express", v)}
                              autoComplete="off"
                            />
                          </FormLayout.Group>
                        </FormLayout>
                      ))}
                    </BlockStack>
                  </BlockStack>
                </Card>

                <InlineStack>
                  <Button variant="primary" onClick={saveSettings} loading={isSaving}>
                    Save settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Published JSON
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    The full config written to the shop metafield on every save.
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
                      <code>{JSON.stringify(draftConfigPreview, null, 2)}</code>
                    </pre>
                  </Box>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}
      </BlockStack>

      {deleteTarget ? (
        <Modal
          open
          onClose={() => setDeleteTarget(null)}
          title={`Delete "${deleteTarget.name || "this motivator"}"?`}
          primaryAction={{
            content: "Delete",
            destructive: true,
            onAction: confirmDelete,
            loading: isSaving,
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setDeleteTarget(null) }]}
        >
          <Modal.Section>
            <Text as="p" variant="bodyMd">
              This removes the motivator from the checkout metafield, so it stops showing at
              checkout.
            </Text>
          </Modal.Section>
        </Modal>
      ) : null}
    </Page>
  );
}
