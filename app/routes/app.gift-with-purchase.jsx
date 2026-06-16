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
  Tabs,
  TextField,
  Select,
  Checkbox,
  FormLayout,
  Divider,
  Modal,
  EmptyState,
  Thumbnail,
  Link,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  syncConfigs,
  getDiscountInfo,
  setDiscountActive,
} from "../lib/gwpAppV1.server";
import {
  SUPPORTED_CURRENCIES,
  DEFAULT_THRESHOLDS,
  DEFAULT_DISCOUNT_PERCENTAGE,
} from "../lib/gwpAppV1.shared";

// Gift With Purchase: the merchant builds and saves each offer here. Every
// saved config (a GwpAppV1Config row) is pushed to a shop metafield read by the
// gift-with-purchase checkout extension AND to a discount metafield read by
// the gift-with-purchase-discount function - all handled by syncConfigs().

// Map the Shopify DiscountStatus enum to merchant-facing wording. A discount
// this app deactivates comes back as EXPIRED, which we surface as "Deactivated".
function discountStatusLabel(status) {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "EXPIRED":
      return "Deactivated";
    case "SCHEDULED":
      return "Scheduled";
    default:
      return "Unknown";
  }
}

function discountStatusTone(status) {
  if (status === "ACTIVE") return "success";
  if (status === "SCHEDULED") return "attention";
  return undefined;
}

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

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const rows = await prisma.gwpAppV1Config.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
  });
  const saved = rows.map((row) => ({
    id: row.id,
    name: row.name,
    configJson: row.configJson,
    updatedAt: row.updatedAt.toISOString(),
  }));

  // Push saved rows to both metafields on every load so the storefront always
  // reflects what's saved here.
  try {
    await syncConfigs(admin, session.shop);
  } catch (err) {
    console.error("Failed to sync GWP V4 configs on load", err);
  }

  const productGids = Array.from(
    new Set(
      saved.flatMap((row) => {
        try {
          const parsed = JSON.parse(row.configJson);
          if (parsed.product_id == null || parsed.product_id === "") return [];
          const raw = String(parsed.product_id).trim();
          if (raw.startsWith("gid://shopify/Product/")) return [raw];
          if (raw.startsWith("gid://")) return []; // variant gid - skip thumbnail
          if (/^\d+$/.test(raw)) return [`gid://shopify/Product/${raw}`];
          return [];
        } catch {
          return [];
        }
      }),
    ),
  );

  const productInfo = {};
  if (productGids.length > 0) {
    try {
      const response = await admin.graphql(
        `#graphql
          query GwpAppV1ProductInfo($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                title
                priceRangeV2 { minVariantPrice { amount currencyCode } }
                featuredMedia {
                  ... on MediaImage { image { url altText } }
                }
              }
            }
          }`,
        { variables: { ids: productGids } },
      );
      const data = await response.json();
      for (const node of data.data?.nodes ?? []) {
        if (!node || !node.id) continue;
        const img = node.featuredMedia?.image ?? null;
        const minPrice = node.priceRangeV2?.minVariantPrice ?? null;
        const numeric = node.id.match(/\/(\d+)$/)?.[1] ?? node.id;
        productInfo[numeric] = {
          imageUrl: img?.url ?? null,
          altText: img?.altText ?? null,
          title: node.title ?? null,
          price: minPrice ? formatMoney(minPrice.amount, minPrice.currencyCode) : null,
        };
      }
    } catch (err) {
      console.error("Failed to fetch GWP V4 product info", err);
    }
  }

  let discountInfo = { exists: false };
  try {
    discountInfo = await getDiscountInfo(admin, session.shop);
  } catch (err) {
    console.error("Failed to fetch GWP discount info", err);
  }

  return json({ saved, productInfo, discountInfo });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    const name = String(formData.get("name") ?? "").trim();
    const configJson = String(formData.get("configJson") ?? "").trim();
    if (!name || !configJson) {
      return json({ ok: false, error: "Name and config are required." });
    }
    try {
      JSON.parse(configJson);
    } catch {
      return json({ ok: false, error: "Config is not valid JSON." });
    }
    const created = await prisma.gwpAppV1Config.create({
      data: { shop: session.shop, name, configJson },
    });
    try {
      await syncConfigs(admin, session.shop);
    } catch (err) {
      console.error("Failed to sync GWP V4 configs (create)", err);
    }
    return json({ ok: true, intent, id: created.id });
  }

  if (intent === "update") {
    const id = String(formData.get("id") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    const configJson = String(formData.get("configJson") ?? "").trim();
    if (!id || !name || !configJson) {
      return json({ ok: false, error: "Missing fields for update." });
    }
    try {
      JSON.parse(configJson);
    } catch {
      return json({ ok: false, error: "Config is not valid JSON." });
    }
    const existing = await prisma.gwpAppV1Config.findFirst({
      where: { id, shop: session.shop },
    });
    if (!existing) return json({ ok: false, error: "Config not found." });
    await prisma.gwpAppV1Config.update({ where: { id }, data: { name, configJson } });
    try {
      await syncConfigs(admin, session.shop);
    } catch (err) {
      console.error("Failed to sync GWP V4 configs (update)", err);
    }
    return json({ ok: true, intent, id });
  }

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    if (!id) return json({ ok: false, error: "Missing id." });
    const existing = await prisma.gwpAppV1Config.findFirst({
      where: { id, shop: session.shop },
    });
    if (!existing) return json({ ok: false, error: "Config not found." });
    await prisma.gwpAppV1Config.delete({ where: { id } });
    try {
      await syncConfigs(admin, session.shop);
    } catch (err) {
      console.error("Failed to sync GWP V4 configs (delete)", err);
    }
    return json({ ok: true, intent, id });
  }

  if (intent === "create_discount") {
    try {
      await syncConfigs(admin, session.shop);
      const info = await getDiscountInfo(admin, session.shop);
      if (!info.exists) {
        return json({
          ok: false,
          error:
            "Nothing to create yet - add an enabled config with a gift product first.",
        });
      }
      return json({ ok: true, intent, discountInfo: info });
    } catch (err) {
      console.error("Failed to create GWP discount", err);
      return json({ ok: false, error: "Could not create the discount." });
    }
  }

  if (intent === "activate_discount" || intent === "deactivate_discount") {
    const active = intent === "activate_discount";
    try {
      await setDiscountActive(admin, active);
      const info = await getDiscountInfo(admin, session.shop);
      return json({ ok: true, intent, discountInfo: info });
    } catch (err) {
      console.error("Failed to toggle GWP discount", err);
      return json({
        ok: false,
        error: err?.message || "Could not update the discount.",
      });
    }
  }

  return json({ ok: false, error: "Unknown intent." });
};

const DEFAULT_COPY = {
  admin_title: "{{ free_gift }} GWP - {{ trigger_type }}",
  banner_title_before: "You're close!",
  banner_message_before: "Spend {{ remaining }} more to get a FREE {{ title }}.",
  banner_title_after: "You scored a free gift!",
  banner_message_after: "We added your free {{ title }} to your cart.",
  banner_title_redeemed: "You've already redeemed your {{ free_gift }}.",
  banner_message_redeemed: "Sorry, you've already redeemed. One per customer.",
  banner_title_region: "Sorry, this gift isn't available in your region.",
  banner_message_region: "Sorry, we are only shipping this gift to {{ allowed }}.",
};

// datetime-local (YYYY-MM-DDTHH:MM) <-> the checkout's separate date/time keys.
function localToDateTimeParts(local) {
  if (!local) return { date: "", time: "" };
  const [d, t] = local.split("T");
  return { date: d || "", time: (t || "").slice(0, 5) };
}
function dateTimePartsToLocal(date, time) {
  const d = typeof date === "string" ? date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const tRaw = typeof time === "string" ? time.trim() : "";
  const t = /^\d{2}:\d{2}/.test(tRaw) ? tRaw.slice(0, 5) : "00:00";
  return `${d}T${t}`;
}

function emptyMinSpend() {
  return SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = String(DEFAULT_THRESHOLDS[code] ?? "");
    return acc;
  }, {});
}

const INITIAL_BUILDER = {
  enabled: true,
  mode: "live",
  trigger_type: "min_spend",
  redemption_type: "one_per_order",
  show_banners: true,
  show_success_banner: true,
  label: "LIMITED OFFER",
  admin_title: DEFAULT_COPY.admin_title,
  discount_percentage: String(DEFAULT_DISCOUNT_PERCENTAGE),
  product_tag: "",
  min_spend: emptyMinSpend(),
  min_spend_currency: "AUD",
  product_id: "",
  product_title: "",
  product_image: "",
  product_price: "",
  shipping_countries: "all",
  customer_redeemed_tag: "",
  valid_from: "",
  valid_to: "",
  button_url: "",
  button_text: "",
  banner_title_before: DEFAULT_COPY.banner_title_before,
  banner_message_before: DEFAULT_COPY.banner_message_before,
  banner_title_after: DEFAULT_COPY.banner_title_after,
  banner_message_after: DEFAULT_COPY.banner_message_after,
  banner_title_redeemed: DEFAULT_COPY.banner_title_redeemed,
  banner_message_redeemed: DEFAULT_COPY.banner_message_redeemed,
  banner_title_region: DEFAULT_COPY.banner_title_region,
  banner_message_region: DEFAULT_COPY.banner_message_region,
};

function buildConfig(state) {
  const config = {
    enabled: state.enabled,
    mode: state.mode,
    trigger_type: state.trigger_type,
    redemption_type: state.redemption_type,
    show_banners: state.show_banners,
    show_success_banner: state.show_success_banner,
  };
  if (state.label.trim()) config.label = state.label.trim();
  if (state.admin_title.trim()) config.admin_title = state.admin_title.trim();
  const pct = Number(state.discount_percentage);
  if (Number.isFinite(pct)) config.discount_percentage = pct;
  if (state.trigger_type !== "subscription" && state.product_tag.trim()) {
    config.product_tag = state.product_tag.trim();
  }
  if (state.trigger_type === "min_spend") {
    for (const code of SUPPORTED_CURRENCIES) {
      const n = Number(state.min_spend[code]);
      if (state.min_spend[code] !== "" && !Number.isNaN(n)) {
        config[`min_spend_${code}`] = n;
      }
    }
    config.min_spend_currency = state.min_spend_currency;
  }
  const productIdNum = Number(state.product_id);
  if (state.product_id.trim() && !Number.isNaN(productIdNum)) {
    config.product_id = productIdNum;
  } else if (state.product_id.trim()) {
    config.product_id = state.product_id.trim();
  }
  if (state.shipping_countries.trim()) {
    config.shipping_countries = state.shipping_countries.trim();
  }
  if (state.redemption_type === "one_per_customer" && state.customer_redeemed_tag.trim()) {
    config.customer_redeemed_tag = state.customer_redeemed_tag.trim();
  }
  const vf = localToDateTimeParts(state.valid_from);
  if (vf.date) {
    config.valid_date_from = vf.date;
    if (vf.time) config.valid_time_from = vf.time;
  }
  const vt = localToDateTimeParts(state.valid_to);
  if (vt.date) {
    config.valid_date_till = vt.date;
    if (vt.time) config.valid_time_till = vt.time;
  }
  if (state.button_url.trim()) config.button_url = state.button_url.trim();
  if (state.button_text.trim()) config.button_text = state.button_text.trim();
  if (state.banner_title_before) config.banner_title_before = state.banner_title_before;
  if (state.banner_message_before) config.banner_message_before = state.banner_message_before;
  if (state.banner_title_after) config.banner_title_after = state.banner_title_after;
  if (state.banner_message_after) config.banner_message_after = state.banner_message_after;
  if (state.banner_title_redeemed) config.banner_title_redeemed = state.banner_title_redeemed;
  if (state.banner_message_redeemed) config.banner_message_redeemed = state.banner_message_redeemed;
  if (state.banner_title_region) config.banner_title_region = state.banner_title_region;
  if (state.banner_message_region) config.banner_message_region = state.banner_message_region;
  return config;
}

function builderFromConfig(c) {
  const redemption_type =
    String(c.redemption_type ?? (c.customer_redeemed_tag ? "one_per_customer" : "one_per_order")) ===
    "one_per_customer"
      ? "one_per_customer"
      : "one_per_order";
  const min_spend = SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] =
      c[`min_spend_${code}`] != null
        ? String(c[`min_spend_${code}`])
        : String(DEFAULT_THRESHOLDS[code] ?? "");
    return acc;
  }, {});
  return {
    enabled: c.enabled !== false,
    mode: c.mode === "test" ? "test" : "live",
    trigger_type: c.trigger_type ?? "min_spend",
    redemption_type,
    show_banners: c.show_banners !== false,
    show_success_banner: c.show_success_banner !== false,
    label: c.label ?? "",
    admin_title: c.admin_title ?? "",
    discount_percentage:
      c.discount_percentage != null
        ? String(c.discount_percentage)
        : String(DEFAULT_DISCOUNT_PERCENTAGE),
    product_tag: c.product_tag ?? "",
    min_spend,
    min_spend_currency: c.min_spend_currency ?? "AUD",
    product_id: c.product_id != null ? String(c.product_id) : "",
    product_title: "",
    product_image: "",
    product_price: "",
    shipping_countries: c.shipping_countries ?? "all",
    customer_redeemed_tag: c.customer_redeemed_tag ?? "",
    valid_from: dateTimePartsToLocal(c.valid_date_from, c.valid_time_from),
    valid_to: dateTimePartsToLocal(c.valid_date_till, c.valid_time_till),
    button_url: c.button_url ?? "",
    button_text: c.button_text ?? "",
    banner_title_before: c.banner_title_before ?? "",
    banner_message_before: c.banner_message_before ?? "",
    banner_title_after: c.banner_title_after ?? "",
    banner_message_after: c.banner_message_after ?? "",
    banner_title_redeemed: c.banner_title_redeemed ?? "",
    banner_message_redeemed: c.banner_message_redeemed ?? "",
    banner_title_region: c.banner_title_region ?? "",
    banner_message_region: c.banner_message_region ?? "",
  };
}

function extractNumericId(gid) {
  const match = gid.match(/\/(\d+)$/);
  return match ? match[1] : "";
}

function formatTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function GiftWithPurchasePage() {
  const { saved, productInfo, discountInfo } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  const [selectedTab, setSelectedTab] = useState(0);
  const [builder, setBuilder] = useState(INITIAL_BUILDER);
  const [editingId, setEditingId] = useState(null);
  const [configName, setConfigName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);

  const update = (key, value) =>
    setBuilder((prev) => ({ ...prev, [key]: value }));
  const updateMinSpend = (code, value) =>
    setBuilder((prev) => ({
      ...prev,
      min_spend: { ...prev.min_spend, [code]: value },
    }));

  const generatedConfig = useMemo(() => buildConfig(builder), [builder]);
  const isSaving = fetcher.state === "submitting" || fetcher.state === "loading";
  const lastResult = fetcher.data;

  useEffect(() => {
    if (!lastResult) return;
    if (lastResult.ok) {
      if (lastResult.intent === "create") {
        setEditingId(lastResult.id);
        shopify.toast.show("Saved and pushed to checkout");
      } else if (lastResult.intent === "update") {
        shopify.toast.show("Updated and pushed to checkout");
      } else if (lastResult.intent === "delete") {
        if (editingId && editingId === lastResult.id) {
          setEditingId(null);
          setConfigName("");
          setBuilder(INITIAL_BUILDER);
        }
        shopify.toast.show("Deleted");
      } else if (lastResult.intent === "create_discount") {
        shopify.toast.show("Discount created");
      } else if (lastResult.intent === "activate_discount") {
        shopify.toast.show("Discount activated");
      } else if (lastResult.intent === "deactivate_discount") {
        shopify.toast.show("Discount deactivated");
      }
    } else if (lastResult.error) {
      shopify.toast.show(lastResult.error, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResult]);

  const copyJson = async (config, minified) => {
    const text = minified
      ? JSON.stringify(config)
      : JSON.stringify(config, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      shopify.toast.show(`JSON copied${minified ? " (minified)" : ""}`);
    } catch {
      shopify.toast.show("Copy failed - select the JSON manually", {
        isError: true,
      });
    }
  };

  const pickProduct = async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
      filter: { variants: false, archived: false },
    });
    if (!selection || selection.length === 0) return;
    const product = selection[0];
    const image =
      product.images?.[0]?.originalSrc ||
      product.images?.[0]?.src ||
      product.images?.[0]?.url ||
      "";
    const rawPrice = product.variants?.[0]?.price;
    const priceAmount =
      typeof rawPrice === "string" ? rawPrice : rawPrice?.amount ?? "";
    setBuilder((prev) => ({
      ...prev,
      product_id: extractNumericId(product.id),
      product_title: product.title,
      product_image: image,
      product_price: priceAmount ? `$${Number(priceAmount).toFixed(2)}` : "",
    }));
  };

  const loadSaved = useCallback(
    (row) => {
      try {
        const parsed = JSON.parse(row.configJson);
        setBuilder(builderFromConfig(parsed));
      } catch {
        shopify.toast.show("Stored config is invalid JSON", { isError: true });
        return;
      }
      setEditingId(row.id);
      setConfigName(row.name);
      setSelectedTab(1);
    },
    [shopify],
  );

  const duplicateSaved = (row) => {
    try {
      const parsed = JSON.parse(row.configJson);
      setBuilder(builderFromConfig(parsed));
    } catch {
      shopify.toast.show("Stored config is invalid JSON", { isError: true });
      return;
    }
    setEditingId(null);
    setConfigName(`${row.name} (copy)`);
    setSelectedTab(1);
    shopify.toast.show(`Duplicated "${row.name}" - save to keep the copy`);
  };

  const newConfig = () => {
    setBuilder(INITIAL_BUILDER);
    setEditingId(null);
    setConfigName("");
    setSelectedTab(1);
  };

  const saveNew = () => {
    if (!configName.trim()) {
      shopify.toast.show("Add a name before saving", { isError: true });
      return;
    }
    const formData = new FormData();
    formData.set("intent", "create");
    formData.set("name", configName.trim());
    formData.set("configJson", JSON.stringify(generatedConfig));
    fetcher.submit(formData, { method: "POST" });
  };

  const updateExisting = () => {
    if (!editingId) return;
    if (!configName.trim()) {
      shopify.toast.show("Name cannot be empty", { isError: true });
      return;
    }
    const formData = new FormData();
    formData.set("intent", "update");
    formData.set("id", editingId);
    formData.set("name", configName.trim());
    formData.set("configJson", JSON.stringify(generatedConfig));
    fetcher.submit(formData, { method: "POST" });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const formData = new FormData();
    formData.set("intent", "delete");
    formData.set("id", deleteTarget.id);
    fetcher.submit(formData, { method: "POST" });
    setDeleteTarget(null);
  };

  const submitDiscountIntent = (intent) => {
    const formData = new FormData();
    formData.set("intent", intent);
    fetcher.submit(formData, { method: "POST" });
  };

  const tabs = [
    {
      id: "saved",
      content: `Saved${saved.length > 0 ? ` (${saved.length})` : ""}`,
      panelID: "saved-panel",
    },
    { id: "builder", content: "Builder", panelID: "builder-panel" },
    { id: "discount", content: "Discount", panelID: "discount-panel" },
  ];

  const showProductTag = builder.trigger_type !== "subscription";
  const showMinSpend = builder.trigger_type === "min_spend";
  const showRedeemedTag = builder.redemption_type === "one_per_customer";

  return (
    <Page>
      <TitleBar title="Gift With Purchase" />
      <BlockStack gap="500">
        <Card padding="0">
          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} />
        </Card>

        {selectedTab === 1 && (
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      {editingId ? "Edit saved config" : "Build a config"}
                    </Text>
                    {editingId ? <Badge tone="info">Editing saved</Badge> : null}
                  </InlineStack>
                  <Text as="p" variant="bodyMd">
                    Build a gift here and save it. Saved configs are pushed
                    straight to the Gift With Purchase checkout extension and
                    the discount function - no JSON to copy or paste. Every
                    enabled config renders its own gift in checkout. Toggle
                    Enabled off to switch a gift off without deleting it.
                  </Text>

                  <FormLayout>
                    <TextField
                      label="Config name"
                      value={configName}
                      onChange={setConfigName}
                      autoComplete="off"
                      placeholder="e.g. Morning Essentials (GWP)"
                      helpText="A label so you can find this config later in Saved."
                    />

                    <Checkbox
                      label="Enabled"
                      checked={builder.enabled}
                      onChange={(v) => update("enabled", v)}
                      helpText="Turn the gift on or off in checkout without removing the config."
                    />

                    <Select
                      label="Mode"
                      options={[
                        { label: "Live (real checkouts)", value: "live" },
                        { label: "Test (Checkout Editor preview only)", value: "test" },
                      ]}
                      value={builder.mode}
                      onChange={(v) => update("mode", v === "test" ? "test" : "live")}
                      helpText="Test configs only render inside the Checkout Editor preview, so customers never see them on live checkout."
                    />

                    <Checkbox
                      label="Show banners"
                      checked={builder.show_banners}
                      onChange={(v) => update("show_banners", v)}
                      helpText="Show the progress and status banners in checkout for this gift."
                    />

                    <Checkbox
                      label="Show success banner"
                      checked={builder.show_success_banner}
                      onChange={(v) => update("show_success_banner", v)}
                      helpText="Show the success banner after the gift is added. Independent of 'Show banners'."
                    />

                    <Select
                      label="Trigger type"
                      options={[
                        { label: "Min spend", value: "min_spend" },
                        { label: "Subscription", value: "subscription" },
                        { label: "Buy X get Y", value: "buy_x_get_y" },
                      ]}
                      value={builder.trigger_type}
                      onChange={(v) => update("trigger_type", v)}
                      helpText="Picks the rule that unlocks the gift."
                    />

                    <TextField
                      label="Label"
                      value={builder.label}
                      onChange={(v) => update("label", v)}
                      autoComplete="off"
                      placeholder="e.g. LIMITED OFFER"
                      helpText="Short pill shown above the progress banner for every trigger type. Leave blank to hide it."
                    />

                    <TextField
                      label="Admin title"
                      value={builder.admin_title}
                      onChange={(v) => update("admin_title", v)}
                      autoComplete="off"
                      placeholder="e.g. {{ free_gift }} GWP - {{ trigger_type }}"
                      helpText="Internal label, not shown to customers. Also tags the gift line in the cart. Supports {{ free_gift }} (gift product title) and {{ trigger_type }}."
                    />

                    <TextField
                      label="Discount percentage off the gift"
                      type="number"
                      value={builder.discount_percentage}
                      onChange={(v) => update("discount_percentage", v)}
                      autoComplete="off"
                      suffix="%"
                      min={1}
                      max={100}
                      helpText="The gift-with-purchase-discount function applies this off the gift line. 100 = free gift; 50 = half price (purchase-with-purchase)."
                    />

                    {showProductTag && (
                      <TextField
                        label={
                          builder.trigger_type === "min_spend"
                            ? "Product tag (qualifying products, optional)"
                            : "Product tag (qualifying products)"
                        }
                        value={builder.product_tag}
                        onChange={(v) => update("product_tag", v)}
                        autoComplete="off"
                        placeholder="e.g. gwp--qualifying_buy"
                        helpText={
                          builder.trigger_type === "min_spend"
                            ? "Only cart lines whose product carries this tag count toward the spend threshold. Leave blank to count the whole cart. Gift cards never count."
                            : "Cart lines whose product carries this tag count toward the trigger."
                        }
                      />
                    )}

                    {showMinSpend && (
                      <>
                        <Divider />
                        <Text as="h3" variant="headingSm">
                          Min spend thresholds
                        </Text>
                        <FormLayout.Group>
                          {SUPPORTED_CURRENCIES.slice(0, 4).map((code) => (
                            <TextField
                              key={code}
                              label={code}
                              type="number"
                              value={builder.min_spend[code]}
                              onChange={(v) => updateMinSpend(code, v)}
                              autoComplete="off"
                            />
                          ))}
                        </FormLayout.Group>
                        <FormLayout.Group>
                          {SUPPORTED_CURRENCIES.slice(4).map((code) => (
                            <TextField
                              key={code}
                              label={code}
                              type="number"
                              value={builder.min_spend[code]}
                              onChange={(v) => updateMinSpend(code, v)}
                              autoComplete="off"
                            />
                          ))}
                        </FormLayout.Group>
                        <Select
                          label="Fallback currency"
                          options={SUPPORTED_CURRENCIES.map((code) => ({
                            label: code,
                            value: code,
                          }))}
                          value={builder.min_spend_currency}
                          onChange={(v) => update("min_spend_currency", v)}
                          helpText="Used when the checkout currency isn't one of the supported currencies."
                        />
                      </>
                    )}

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Gift product
                    </Text>
                    {(() => {
                      const numericId =
                        builder.product_id.match(/\/(\d+)$/)?.[1] ??
                        builder.product_id;
                      const info = numericId ? productInfo[numericId] : undefined;
                      const title = builder.product_title || info?.title || "";
                      const image = builder.product_image || info?.imageUrl || "";
                      const price = builder.product_price || info?.price || "";
                      return (
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          <Button onClick={pickProduct}>Select product</Button>
                          {builder.product_id ? (
                            <InlineStack gap="300" blockAlign="center" wrap={false}>
                              {image ? (
                                <Thumbnail source={image} alt={title || "Gift"} size="small" />
                              ) : null}
                              <BlockStack gap="050">
                                <Text as="span" variant="bodyMd" fontWeight="semibold">
                                  {title || "Product selected"}
                                </Text>
                                {price ? (
                                  <Text as="span" variant="bodySm">
                                    {price}
                                  </Text>
                                ) : null}
                                <Text as="span" variant="bodySm" tone="subdued">
                                  ID: {builder.product_id}
                                </Text>
                              </BlockStack>
                            </InlineStack>
                          ) : (
                            <Text as="span" variant="bodyMd" tone="subdued">
                              No product selected
                            </Text>
                          )}
                        </InlineStack>
                      );
                    })()}
                    <TextField
                      label="Or paste a product ID"
                      value={builder.product_id}
                      onChange={(v) => {
                        setBuilder((prev) => ({
                          ...prev,
                          product_id: v,
                          product_title: "",
                          product_image: "",
                          product_price: "",
                        }));
                      }}
                      autoComplete="off"
                      placeholder="e.g. 7612341846150"
                      helpText="Numeric Shopify product ID (the gift added to cart). Pick via Select product to preview image, title and price."
                    />

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Eligibility and CTA
                    </Text>
                    <TextField
                      label="Shipping countries"
                      value={builder.shipping_countries}
                      onChange={(v) => update("shipping_countries", v)}
                      autoComplete="off"
                      placeholder="all  or  AU,NZ,US,CA,GB,DE,AE"
                      helpText='Comma-separated country codes, country names, or "all".'
                    />
                    <Select
                      label="Redemption limit"
                      options={[
                        { label: "One per order", value: "one_per_order" },
                        { label: "One per customer", value: "one_per_customer" },
                      ]}
                      value={builder.redemption_type}
                      onChange={(v) => update("redemption_type", v)}
                      helpText="One per order: no cross-order check. One per customer: limited once ever via a customer tag."
                    />
                    {showRedeemedTag && (
                      <TextField
                        label="Customer redeemed tag"
                        value={builder.customer_redeemed_tag}
                        onChange={(v) => update("customer_redeemed_tag", v)}
                        autoComplete="off"
                        placeholder="e.g. redeemed_morning_essentials"
                        helpText="Customers carrying this tag are treated as having already redeemed. Set by your post-order flow."
                      />
                    )}

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Schedule (optional)
                    </Text>
                    <FormLayout.Group>
                      <TextField
                        label="Valid from"
                        type="datetime-local"
                        value={builder.valid_from}
                        onChange={(v) => update("valid_from", v)}
                        autoComplete="off"
                        helpText="Leave blank to start immediately. Interpreted as Australia/Melbourne time."
                      />
                      <TextField
                        label="Valid to"
                        type="datetime-local"
                        value={builder.valid_to}
                        onChange={(v) => update("valid_to", v)}
                        autoComplete="off"
                        helpText="Leave blank for no end. Interpreted as Australia/Melbourne time."
                      />
                    </FormLayout.Group>

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Call to action
                    </Text>
                    <FormLayout.Group>
                      <TextField
                        label="Button URL"
                        value={builder.button_url}
                        onChange={(v) => update("button_url", v)}
                        autoComplete="off"
                        placeholder="e.g. gift-with-purchase"
                      />
                      <TextField
                        label="Button text"
                        value={builder.button_text}
                        onChange={(v) => update("button_text", v)}
                        autoComplete="off"
                        placeholder="e.g. Keep shopping"
                      />
                    </FormLayout.Group>

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Banner copy - before unlocked
                    </Text>
                    <TextField
                      label="Title"
                      value={builder.banner_title_before}
                      onChange={(v) => update("banner_title_before", v)}
                      autoComplete="off"
                    />
                    <TextField
                      label="Message"
                      value={builder.banner_message_before}
                      onChange={(v) => update("banner_message_before", v)}
                      autoComplete="off"
                      multiline={2}
                      helpText="Use {{ remaining }} for the remaining spend (min_spend only)."
                    />

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Banner copy - after unlocked
                    </Text>
                    <TextField
                      label="Title"
                      value={builder.banner_title_after}
                      onChange={(v) => update("banner_title_after", v)}
                      autoComplete="off"
                    />
                    <TextField
                      label="Message"
                      value={builder.banner_message_after}
                      onChange={(v) => update("banner_message_after", v)}
                      autoComplete="off"
                      multiline={2}
                    />

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Banner copy - already redeemed
                    </Text>
                    <TextField
                      label="Title"
                      value={builder.banner_title_redeemed}
                      onChange={(v) => update("banner_title_redeemed", v)}
                      autoComplete="off"
                    />
                    <TextField
                      label="Message"
                      value={builder.banner_message_redeemed}
                      onChange={(v) => update("banner_message_redeemed", v)}
                      autoComplete="off"
                      multiline={2}
                    />

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Banner copy - region blocked
                    </Text>
                    <TextField
                      label="Title"
                      value={builder.banner_title_region}
                      onChange={(v) => update("banner_title_region", v)}
                      autoComplete="off"
                    />
                    <TextField
                      label="Message"
                      value={builder.banner_message_region}
                      onChange={(v) => update("banner_message_region", v)}
                      autoComplete="off"
                      multiline={2}
                      helpText="Use {{ allowed }} for the list of allowed countries."
                    />

                    <Divider />
                    <InlineStack gap="200">
                      <Button onClick={newConfig}>New</Button>
                      <Button onClick={() => setBuilder(INITIAL_BUILDER)}>
                        Reset fields
                      </Button>
                    </InlineStack>
                  </FormLayout>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Save
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Stored per shop and pushed live to checkout on save. Pull
                      saved configs back in from the Saved tab.
                    </Text>
                    <InlineStack gap="200">
                      {editingId ? (
                        <>
                          <Button variant="primary" onClick={updateExisting} loading={isSaving}>
                            Update
                          </Button>
                          <Button onClick={saveNew} loading={isSaving}>
                            Save as new
                          </Button>
                        </>
                      ) : (
                        <Button variant="primary" onClick={saveNew} loading={isSaving}>
                          Save
                        </Button>
                      )}
                    </InlineStack>
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Generated JSON
                  </Text>
                  <InlineStack gap="200">
                    <Button onClick={() => copyJson(generatedConfig, false)}>
                      Copy JSON
                    </Button>
                    <Button onClick={() => copyJson(generatedConfig, true)}>
                      Copy minified
                    </Button>
                  </InlineStack>
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
            </Layout.Section>
          </Layout>
        )}

        {selectedTab === 0 && (
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Saved configs
                    </Text>
                    <Button onClick={newConfig}>New config</Button>
                  </InlineStack>

                  {saved.length === 0 ? (
                    <EmptyState
                      heading="No saved configs yet"
                      action={{ content: "Open builder", onAction: newConfig }}
                      image=""
                    >
                      <p>
                        Build a config in the Builder tab, give it a name, and
                        click Save. It will appear here and go live in checkout.
                      </p>
                    </EmptyState>
                  ) : (
                    <BlockStack gap="300">
                      {saved.map((row) => {
                        let trigger = "unknown";
                        let enabled = true;
                        let mode = "live";
                        let productId = "";
                        let adminTitle = "";
                        try {
                          const parsed = JSON.parse(row.configJson);
                          if (parsed.trigger_type) trigger = parsed.trigger_type;
                          enabled = parsed.enabled !== false;
                          mode = parsed.mode === "test" ? "test" : "live";
                          productId =
                            parsed.product_id != null ? String(parsed.product_id) : "";
                          adminTitle = parsed.admin_title ?? "";
                        } catch {
                          trigger = "unknown";
                        }
                        const isEditing = editingId === row.id;
                        const numericProductId =
                          productId.match(/\/(\d+)$/)?.[1] ?? productId;
                        const imageInfo = numericProductId
                          ? productInfo[numericProductId]
                          : undefined;
                        const thumbAlt = imageInfo?.altText || adminTitle || row.name;
                        return (
                          <Card key={row.id}>
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="center">
                                <InlineStack gap="300" blockAlign="center" wrap={false}>
                                  {imageInfo?.imageUrl ? (
                                    <Thumbnail source={imageInfo.imageUrl} alt={thumbAlt} size="small" />
                                  ) : null}
                                  <BlockStack gap="100">
                                    <InlineStack gap="200" blockAlign="center">
                                      <Text as="h3" variant="headingSm">
                                        {row.name}
                                      </Text>
                                      {trigger !== "unknown" ? (
                                        <Badge tone="info">{trigger}</Badge>
                                      ) : (
                                        <Badge tone="warning">invalid JSON</Badge>
                                      )}
                                      {trigger !== "unknown" ? (
                                        <Badge tone={enabled ? "success" : "attention"}>
                                          {enabled ? "Enabled" : "Disabled"}
                                        </Badge>
                                      ) : null}
                                      {trigger !== "unknown" ? (
                                        <Badge tone={mode === "test" ? "warning" : undefined}>
                                          {mode === "test" ? "Test" : "Live"}
                                        </Badge>
                                      ) : null}
                                      {isEditing ? <Badge>Editing</Badge> : null}
                                    </InlineStack>
                                    {adminTitle ? (
                                      <Text as="span" variant="bodySm" tone="subdued">
                                        {adminTitle}
                                      </Text>
                                    ) : null}
                                  </BlockStack>
                                </InlineStack>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  Updated {formatTimestamp(row.updatedAt)}
                                </Text>
                              </InlineStack>
                              <InlineStack gap="200">
                                <Button onClick={() => loadSaved(row)}>Edit</Button>
                                <Button onClick={() => duplicateSaved(row)}>Duplicate</Button>
                                <Button
                                  onClick={() => {
                                    try {
                                      const parsed = JSON.parse(row.configJson);
                                      copyJson(parsed, false);
                                    } catch {
                                      shopify.toast.show("Stored config is invalid JSON", {
                                        isError: true,
                                      });
                                    }
                                  }}
                                >
                                  Copy JSON
                                </Button>
                                <Button
                                  tone="critical"
                                  variant="tertiary"
                                  onClick={() => setDeleteTarget(row)}
                                >
                                  Delete
                                </Button>
                              </InlineStack>
                            </BlockStack>
                          </Card>
                        );
                      })}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}

        {selectedTab === 2 && (
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Discount
                    </Text>
                    {discountInfo?.exists ? (
                      <Badge tone={discountStatusTone(discountInfo.status)}>
                        {discountStatusLabel(discountInfo.status)}
                      </Badge>
                    ) : (
                      <Badge>Not created</Badge>
                    )}
                  </InlineStack>

                  <Text as="p" variant="bodyMd">
                    The app manages a single automatic discount,{" "}
                    <Text as="span" fontWeight="semibold">
                      Gift with purchase
                    </Text>
                    , bound to the gift-with-purchase-discount function. It
                    applies the configured percentage off the gift line once an
                    offer qualifies (e.g. the min-spend threshold is met). Every
                    saved config reuses this one discount - the checkout
                    extension decides when the gift line is added, and this
                    discount makes that line free or % off.
                  </Text>

                  {discountInfo?.exists ? (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Status: {discountStatusLabel(discountInfo.status)}
                      </Text>
                      {discountInfo.adminUrl ? (
                        <Link url={discountInfo.adminUrl} target="_blank">
                          View this discount in Shopify admin
                        </Link>
                      ) : null}
                    </BlockStack>
                  ) : (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      No discount has been created yet. Save an enabled config
                      with a gift product, or use Create discount below.
                    </Text>
                  )}

                  <Divider />

                  <InlineStack gap="200">
                    <Button
                      onClick={() => submitDiscountIntent("create_discount")}
                      loading={isSaving}
                    >
                      Create discount
                    </Button>
                    <Button
                      variant="primary"
                      disabled={
                        !discountInfo?.exists ||
                        discountInfo.status === "ACTIVE"
                      }
                      onClick={() => submitDiscountIntent("activate_discount")}
                      loading={isSaving}
                    >
                      Make active
                    </Button>
                    <Button
                      tone="critical"
                      disabled={
                        !discountInfo?.exists ||
                        discountInfo.status !== "ACTIVE"
                      }
                      onClick={() => submitDiscountIntent("deactivate_discount")}
                      loading={isSaving}
                    >
                      Deactivate
                    </Button>
                  </InlineStack>

                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">
                      If a config is in{" "}
                      <Text as="span" fontWeight="semibold">
                        Test mode
                      </Text>
                      , the discount is created but left{" "}
                      <Text as="span" fontWeight="semibold">
                        deactivated
                      </Text>{" "}
                      so it never applies on real checkouts. To test, update the
                      customer segment to your own email, then activate the
                      discount.
                    </Text>
                  </Banner>
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
          title={`Delete "${deleteTarget.name}"?`}
          primaryAction={{
            content: "Delete",
            destructive: true,
            onAction: confirmDelete,
            loading: isSaving,
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setDeleteTarget(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                This removes the saved config from this shop and from the
                checkout metafield, so the gift stops showing at checkout.
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}
    </Page>
  );
}
