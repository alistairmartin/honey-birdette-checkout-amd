import { useCallback, useEffect, useMemo, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
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
  Box,
  ChoiceList,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  syncConfigs,
  getConfigDiscountMap,
  setConfigDiscountActive,
  createConfigDiscount,
  deleteConfigDiscount,
  listSegments,
} from "../lib/gwpAppV1.server";
import {
  SUPPORTED_CURRENCIES,
  DEFAULT_THRESHOLDS,
  DEFAULT_DISCOUNT_PERCENTAGE,
  TRIGGER_TYPES,
  triggerUsesMinSpend,
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

  // Sync first so per-config discounts are created/updated and each row's
  // discountId is populated before we read the rows back for display.
  let timeZone = "";
  try {
    const result = await syncConfigs(admin, session.shop);
    timeZone = result?.timeZone || "";
  } catch (err) {
    console.error("Failed to sync GWP V4 configs on load", err);
  }

  const rows = await prisma.gwpAppV1Config.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
  });
  const saved = rows.map((row) => ({
    id: row.id,
    name: row.name,
    configJson: row.configJson,
    discountId: row.discountId,
    updatedAt: row.updatedAt.toISOString(),
  }));

  const toThumbnailGid = (value) => {
    if (value == null || value === "") return null;
    const raw = String(value).trim();
    if (raw.startsWith("gid://shopify/Product/")) return raw;
    if (raw.startsWith("gid://")) return null; // variant gid - skip thumbnail
    if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;
    return null;
  };
  const productGids = Array.from(
    new Set(
      saved.flatMap((row) => {
        try {
          const parsed = JSON.parse(row.configJson);
          const ids = [parsed.product_id];
          if (Array.isArray(parsed.gift_options)) {
            for (const opt of parsed.gift_options) {
              ids.push(opt && typeof opt === "object" ? opt.product_id : opt);
            }
          }
          return ids.map(toThumbnailGid).filter(Boolean);
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

  let discountMap = {};
  try {
    discountMap = await getConfigDiscountMap(admin, session.shop, rows);
  } catch (err) {
    console.error("Failed to fetch GWP discount info", err);
  }

  const segments = await listSegments(admin);

  return json({ saved, productInfo, discountMap, segments, timeZone });
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
    // Delete this config's own discount before removing the row.
    if (existing.discountId) {
      try {
        await deleteConfigDiscount(admin, existing.discountId);
      } catch (err) {
        console.error("Failed to delete GWP discount on config delete", err);
      }
    }
    await prisma.gwpAppV1Config.delete({ where: { id } });
    try {
      await syncConfigs(admin, session.shop);
    } catch (err) {
      console.error("Failed to sync GWP V4 configs (delete)", err);
    }
    return json({ ok: true, intent, id });
  }

  if (intent === "create_discount") {
    const id = String(formData.get("id") ?? "");
    if (!id) return json({ ok: false, error: "Missing config id." });
    try {
      await createConfigDiscount(admin, session.shop, id);
      return json({ ok: true, intent, id });
    } catch (err) {
      console.error("Failed to create GWP discount", err);
      return json({
        ok: false,
        error: err?.message || "Could not create the discount.",
      });
    }
  }

  if (intent === "activate_discount" || intent === "deactivate_discount") {
    const id = String(formData.get("id") ?? "");
    if (!id) return json({ ok: false, error: "Missing config id." });
    const active = intent === "activate_discount";
    try {
      await setConfigDiscountActive(admin, session.shop, id, active);
      return json({ ok: true, intent, id });
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
  banner_subtitle: "",
  banner_buy_x_hint: "Add a qualifying product to unlock this offer",
  banner_title_before: "You're close!",
  banner_message_before: "Spend {{ remaining }} more to get a FREE {{ title }}.",
  banner_title_after: "You scored a free gift!",
  banner_message_after: "We added your free {{ title }} to your cart.",
  banner_title_added: "Your gift is in your cart",
  banner_message_added: "Your {{ title }} is in your cart and your discount is applied.",
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
  description: "",
  trigger_type: "min_spend",
  redemption_type: "one_per_order",
  max_total_uses: "",
  show_banners: true,
  show_success_banner: true,
  label: "LIMITED OFFER",
  admin_title: DEFAULT_COPY.admin_title,
  discount_title: "",
  discount_percentage: String(DEFAULT_DISCOUNT_PERCENTAGE),
  product_tag: "",
  min_spend: emptyMinSpend(),
  min_spend_currency: "AUD",
  add_mode: "auto",
  auto_remove_gift: false,
  product_id: "",
  product_title: "",
  product_image: "",
  product_price: "",
  // Additional gift products. When one or more are set, the offer becomes a
  // "pick one of N" gift (primary + extras) shown as cards in checkout, and the
  // customer must choose one (always manual, regardless of add_mode).
  extra_gift_options: [],
  shipping_countries: "all",
  customer_redeemed_tag: "",
  eligibility: "all",
  eligible_emails: "",
  eligible_segments: [],
  combines_product: false,
  combines_order: false,
  combines_shipping: false,
  valid_from: "",
  valid_to: "",
  button_url: "",
  button_text: "",
  banner_subtitle: DEFAULT_COPY.banner_subtitle,
  banner_buy_x_hint: DEFAULT_COPY.banner_buy_x_hint,
  banner_title_before: DEFAULT_COPY.banner_title_before,
  banner_message_before: DEFAULT_COPY.banner_message_before,
  banner_title_after: DEFAULT_COPY.banner_title_after,
  banner_message_after: DEFAULT_COPY.banner_message_after,
  banner_title_added: DEFAULT_COPY.banner_title_added,
  banner_message_added: DEFAULT_COPY.banner_message_added,
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
    add_mode: state.add_mode === "manual" ? "manual" : "auto",
    auto_remove_gift: !!state.auto_remove_gift,
  };
  if (state.description.trim()) config.description = state.description.trim();
  if (state.label.trim()) config.label = state.label.trim();
  if (state.admin_title.trim()) config.admin_title = state.admin_title.trim();
  if (state.discount_title.trim()) config.discount_title = state.discount_title.trim();
  const pct = Number(state.discount_percentage);
  if (Number.isFinite(pct)) config.discount_percentage = pct;
  if (state.trigger_type !== "subscription" && state.product_tag.trim()) {
    config.product_tag = state.product_tag.trim();
  }
  if (triggerUsesMinSpend(state.trigger_type)) {
    for (const code of SUPPORTED_CURRENCIES) {
      const n = Number(state.min_spend[code]);
      if (state.min_spend[code] !== "" && !Number.isNaN(n)) {
        config[`min_spend_${code}`] = n;
      }
    }
    config.min_spend_currency = state.min_spend_currency;
  }
  const coerceProductId = (raw) => {
    const str = String(raw ?? "").trim();
    if (!str) return null;
    const num = Number(str);
    return !Number.isNaN(num) ? num : str;
  };
  const primaryId = coerceProductId(state.product_id);
  if (primaryId != null) config.product_id = primaryId;
  // Build the full gift-option set (primary + extras). Only emit gift_options
  // when there's more than one distinct gift, so single-gift configs stay clean.
  const extraIds = (Array.isArray(state.extra_gift_options) ? state.extra_gift_options : [])
    .map((o) => coerceProductId(o?.product_id))
    .filter((id) => id != null);
  const allGiftIds = [primaryId, ...extraIds].filter((id) => id != null);
  const uniqueGiftIds = allGiftIds.filter(
    (id, i) => allGiftIds.findIndex((x) => String(x) === String(id)) === i,
  );
  if (uniqueGiftIds.length > 1) {
    config.gift_options = uniqueGiftIds.map((id) => ({ product_id: id }));
  }
  if (state.shipping_countries.trim()) {
    config.shipping_countries = state.shipping_countries.trim();
  }
  if (state.redemption_type === "one_per_customer" && state.customer_redeemed_tag.trim()) {
    config.customer_redeemed_tag = state.customer_redeemed_tag.trim();
  }
  // Cap on how many times this offer's discount can be used in total. Positive
  // integer only; blank/0 means unlimited. Enforced by the app deactivating the
  // discount once its usage reaches this, and by the checkout showing "sold out".
  const maxTotalUses = Number(state.max_total_uses);
  if (Number.isFinite(maxTotalUses) && maxTotalUses > 0) {
    config.max_total_uses = Math.floor(maxTotalUses);
  }
  config.combines_with = {
    orderDiscounts: !!state.combines_order,
    productDiscounts: !!state.combines_product,
    shippingDiscounts: !!state.combines_shipping,
  };
  const eligibility =
    state.eligibility === "customers" || state.eligibility === "segments"
      ? state.eligibility
      : "all";
  config.eligibility = eligibility;
  if (eligibility === "customers") {
    const emails = String(state.eligible_emails || "")
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (emails.length) config.eligible_emails = emails;
  } else if (eligibility === "segments") {
    const segs = Array.isArray(state.eligible_segments)
      ? state.eligible_segments.filter(Boolean)
      : [];
    if (segs.length) config.eligible_segment_ids = segs;
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
  if (state.banner_subtitle) config.banner_subtitle = state.banner_subtitle;
  if (state.banner_buy_x_hint) config.banner_buy_x_hint = state.banner_buy_x_hint;
  if (state.banner_title_before) config.banner_title_before = state.banner_title_before;
  if (state.banner_message_before) config.banner_message_before = state.banner_message_before;
  if (state.banner_title_after) config.banner_title_after = state.banner_title_after;
  if (state.banner_message_after) config.banner_message_after = state.banner_message_after;
  if (state.banner_title_added) config.banner_title_added = state.banner_title_added;
  if (state.banner_message_added) config.banner_message_added = state.banner_message_added;
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
    description: c.description ?? "",
    trigger_type: c.trigger_type ?? "min_spend",
    redemption_type,
    max_total_uses: c.max_total_uses != null ? String(c.max_total_uses) : "",
    show_banners: c.show_banners !== false,
    show_success_banner: c.show_success_banner !== false,
    label: c.label ?? "",
    admin_title: c.admin_title ?? "",
    discount_title: c.discount_title ?? "",
    discount_percentage:
      c.discount_percentage != null
        ? String(c.discount_percentage)
        : String(DEFAULT_DISCOUNT_PERCENTAGE),
    product_tag: c.product_tag ?? "",
    min_spend,
    min_spend_currency: c.min_spend_currency ?? "AUD",
    add_mode: c.add_mode === "manual" ? "manual" : "auto",
    auto_remove_gift: c.auto_remove_gift === true,
    product_id:
      c.product_id != null
        ? String(c.product_id)
        : Array.isArray(c.gift_options) && c.gift_options[0]
          ? String(c.gift_options[0].product_id ?? c.gift_options[0])
          : "",
    product_title: "",
    product_image: "",
    product_price: "",
    // gift_options[0] is the primary gift (mirrors config.product_id); the rest
    // are the extra options. Hydrate just the extras here.
    extra_gift_options: Array.isArray(c.gift_options)
      ? c.gift_options.slice(1).map((o) => ({
          product_id: String((o && typeof o === "object" ? o.product_id : o) ?? ""),
          product_title: "",
          product_image: "",
          product_price: "",
        }))
      : [],
    shipping_countries: c.shipping_countries ?? "all",
    customer_redeemed_tag: c.customer_redeemed_tag ?? "",
    eligibility:
      c.eligibility === "customers" || c.eligibility === "segments"
        ? c.eligibility
        : "all",
    eligible_emails: Array.isArray(c.eligible_emails)
      ? c.eligible_emails.join("\n")
      : "",
    eligible_segments: Array.isArray(c.eligible_segment_ids)
      ? c.eligible_segment_ids
      : [],
    combines_product: c.combines_with?.productDiscounts === true,
    combines_order: c.combines_with?.orderDiscounts === true,
    combines_shipping: c.combines_with?.shippingDiscounts === true,
    valid_from: dateTimePartsToLocal(c.valid_date_from, c.valid_time_from),
    valid_to: dateTimePartsToLocal(c.valid_date_till, c.valid_time_till),
    button_url: c.button_url ?? "",
    button_text: c.button_text ?? "",
    banner_subtitle: c.banner_subtitle ?? "",
    banner_buy_x_hint: c.banner_buy_x_hint ?? "",
    banner_title_before: c.banner_title_before ?? "",
    banner_message_before: c.banner_message_before ?? "",
    banner_title_after: c.banner_title_after ?? "",
    banner_message_after: c.banner_message_after ?? "",
    banner_title_added: c.banner_title_added ?? "",
    banner_message_added: c.banner_message_added ?? "",
    banner_title_redeemed: c.banner_title_redeemed ?? "",
    banner_message_redeemed: c.banner_message_redeemed ?? "",
    banner_title_region: c.banner_title_region ?? "",
    banner_message_region: c.banner_message_region ?? "",
  };
}

// Plain-English recap of a config's rules, shown under the config name in the
// builder and on each Saved card so the merchant can sanity-check the offer
// without decoding the JSON. Returns one sentence per rule.
function summarizeConfig(c, { productInfo = {}, extraTitles = {}, segments = [] } = {}) {
  if (!c || typeof c !== "object") return [];
  const lines = [];

  const nameFor = (id) => {
    const numeric = String(id ?? "").match(/\/(\d+)$/)?.[1] ?? String(id ?? "");
    return (
      extraTitles[numeric] ||
      productInfo[numeric]?.title ||
      (numeric ? `product ${numeric}` : "")
    );
  };

  const trigger = String(c.trigger_type || "min_spend");
  const tag = String(c.product_tag || "").trim();

  // Min spend: lead with the fallback currency's threshold (or the first one
  // that's set) and note when other currencies carry their own.
  const preferred = SUPPORTED_CURRENCIES.includes(c.min_spend_currency)
    ? c.min_spend_currency
    : "AUD";
  let spendCur = preferred;
  let spendAmount = Number(c[`min_spend_${preferred}`]);
  if (!Number.isFinite(spendAmount) || spendAmount <= 0) {
    for (const code of SUPPORTED_CURRENCIES) {
      const n = Number(c[`min_spend_${code}`]);
      if (Number.isFinite(n) && n > 0) {
        spendCur = code;
        spendAmount = n;
        break;
      }
    }
  }
  let spendText = "";
  if (Number.isFinite(spendAmount) && spendAmount > 0) {
    const formatted = formatMoney(spendAmount, spendCur);
    spendText = formatted.includes(spendCur) ? formatted : `${formatted} ${spendCur}`;
  }
  const otherThresholds = SUPPORTED_CURRENCIES.filter(
    (code) => code !== spendCur && Number(c[`min_spend_${code}`]) > 0,
  ).length;
  const perCurrencyNote =
    otherThresholds > 0 ? " *(each currency has its own threshold)*" : "";

  if (trigger === "min_spend") {
    if (spendText) {
      lines.push(
        tag
          ? `**Trigger:** the customer must spend at least **${spendText}**${perCurrencyNote} on products tagged **"${tag}"**. Gift cards never count.`
          : `**Trigger:** the customer must spend at least **${spendText}**${perCurrencyNote} across their cart (any product on site except gift cards).`,
      );
    } else {
      lines.push(
        "**Trigger:** min spend, but *no threshold is set yet, so the gift can never unlock*.",
      );
    }
  } else if (trigger === "buy_x_get_y") {
    lines.push(
      tag
        ? `**Trigger:** the customer must have at least **1 product tagged "${tag}"** in their cart.`
        : "**Trigger:** Buy X get Y, but *no product tag is set yet, so the gift can never unlock*.",
    );
  } else if (trigger === "buy_x_and_min_spend") {
    const tagPart = tag
      ? `at least **1 product tagged "${tag}"** in their cart`
      : "at least 1 product with the qualifying tag (*not set yet, so the gift can never unlock*)";
    const spendPart = spendText
      ? `a minimum spend of **${spendText}**${perCurrencyNote} across the whole cart (any product on site except gift cards)`
      : "a minimum spend threshold (*not set yet*)";
    lines.push(`**Trigger:** the customer needs ${tagPart} AND ${spendPart}.`);
  } else if (trigger === "subscription") {
    lines.push(
      "**Trigger:** the customer must have a **subscription** (selling plan) item in their cart.",
    );
  } else {
    lines.push(`**Trigger:** ${trigger}.`);
  }

  const giftIds = [];
  const pushGiftId = (raw) => {
    if (raw == null || raw === "") return;
    if (!giftIds.some((x) => String(x) === String(raw))) giftIds.push(raw);
  };
  pushGiftId(c.product_id);
  if (Array.isArray(c.gift_options)) {
    for (const opt of c.gift_options) {
      pushGiftId(opt && typeof opt === "object" ? opt.product_id : opt);
    }
  }
  const pct = Number(c.discount_percentage);
  const pctText =
    !Number.isFinite(pct) || pct >= 100 ? "**free**" : `at **${pct}% off**`;
  if (giftIds.length === 0) {
    lines.push("**Gift:** *no gift product selected yet*.");
  } else if (giftIds.length === 1) {
    lines.push(
      `**Gift:** __${nameFor(giftIds[0])}__ ${pctText}, ${
        c.add_mode === "manual"
          ? "added when the customer taps the Add button"
          : "added to the cart automatically once they qualify"
      }.`,
    );
  } else {
    lines.push(
      `**Gift:** the customer picks **1 of ${giftIds.length} options** (${giftIds
        .map((id) => `__${nameFor(id)}__`)
        .join(", ")}) ${pctText}, always added manually.`,
    );
  }

  const onePerCustomer =
    String(
      c.redemption_type ??
        (c.customer_redeemed_tag ? "one_per_customer" : "one_per_order"),
    ) === "one_per_customer";
  const capN = Number(c.max_total_uses);
  const capText =
    Number.isFinite(capN) && capN > 0
      ? ` Limited to **${Math.floor(capN)} total redemptions**, then it shows as sold out.`
      : "";
  lines.push(
    (onePerCustomer
      ? `**Redemption:** one per **customer**${
          c.customer_redeemed_tag
            ? ` (tracked via the **"${c.customer_redeemed_tag}"** customer tag)`
            : ""
        }.`
      : "**Redemption:** one per **order** (no cross-order limit).") + capText,
  );

  if (c.eligibility === "customers") {
    const emails = Array.isArray(c.eligible_emails) ? c.eligible_emails : [];
    lines.push(
      emails.length
        ? `**Eligible customers:** ${emails.slice(0, 6).join(", ")}${
            emails.length > 6 ? ` and **${emails.length - 6} more**` : ""
          }.`
        : "**Eligible customers:** specific customers selected, but *no emails entered yet*.",
    );
  } else if (c.eligibility === "segments") {
    const ids = Array.isArray(c.eligible_segment_ids) ? c.eligible_segment_ids : [];
    const names = ids.map((id) => segments.find((s) => s.id === id)?.name || id);
    lines.push(
      names.length
        ? `**Eligible segments:** ${names.map((n) => `**${n}**`).join(", ")}.`
        : "**Eligible segments:** *none selected yet*.",
    );
  } else {
    lines.push("**Eligible customers:** everyone.");
  }

  const ship = String(c.shipping_countries || "all").trim();
  if (ship && ship.toLowerCase() !== "all") {
    lines.push(`**Only available when shipping to:** ${ship}.`);
  }

  const combos = [];
  if (c.combines_with?.productDiscounts) combos.push("product");
  if (c.combines_with?.orderDiscounts) combos.push("order");
  if (c.combines_with?.shippingDiscounts) combos.push("shipping");
  lines.push(
    combos.length
      ? `**Combines** with **${combos.join(", ")}** discounts.`
      : "Does **not combine** with any other discounts.",
  );

  const from = c.valid_date_from
    ? `${c.valid_date_from}${c.valid_time_from ? ` ${c.valid_time_from}` : ""}`
    : "";
  const till = c.valid_date_till
    ? `${c.valid_date_till}${c.valid_time_till ? ` ${c.valid_time_till}` : ""}`
    : "";
  if (from && till) {
    lines.push(`**Scheduled:** runs from **${from}** until **${till}** (store time).`);
  } else if (from) {
    lines.push(`**Scheduled:** starts **${from}** (store time), no end date.`);
  } else if (till) {
    lines.push(`**Scheduled:** ends **${till}** (store time).`);
  }

  if (c.enabled === false) {
    lines.push("*Currently disabled: the gift is not shown in checkout.*");
  }
  if (c.mode === "test") {
    lines.push(
      "*Test mode: only visible in the Checkout Editor preview, never on live checkout.*",
    );
  }

  return lines;
}

// Renders the lightweight **bold** / __underline__ / *italic* markers that
// summarizeConfig embeds in its sentences. Not a markdown parser - just these
// three inline tokens, everything else passes through as plain text.
function renderSummaryLine(line) {
  const parts = String(line).split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("__") && part.endsWith("__") && part.length > 4) {
      return <u key={i}>{part.slice(2, -2)}</u>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
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
  const { saved, productInfo, discountMap, segments, timeZone } = useLoaderData();
  const tzLabel = timeZone || "your store's timezone";
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
  // Titles for products picked in this session but not yet saved - the loader's
  // productInfo only covers products referenced by already-saved configs.
  const pickedTitles = useMemo(() => {
    const map = {};
    const put = (id, title) => {
      const numeric = String(id ?? "").match(/\/(\d+)$/)?.[1] ?? String(id ?? "");
      if (numeric && title) map[numeric] = title;
    };
    put(builder.product_id, builder.product_title);
    for (const opt of builder.extra_gift_options || []) {
      put(opt.product_id, opt.product_title);
    }
    return map;
  }, [builder.product_id, builder.product_title, builder.extra_gift_options]);
  const builderSummary = useMemo(
    () =>
      summarizeConfig(generatedConfig, {
        productInfo,
        extraTitles: pickedTitles,
        segments,
      }),
    [generatedConfig, productInfo, pickedTitles, segments],
  );
  // Exactly what gets saved and pushed to the metafields - handy to paste into a
  // bug report. Reflects unsaved builder edits, not the last saved state.
  const generatedConfigJson = useMemo(
    () => JSON.stringify(generatedConfig, null, 2),
    [generatedConfig],
  );
  const [jsonCopied, setJsonCopied] = useState(false);
  const copyConfigJson = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generatedConfigJson);
      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions, or an insecure context). The JSON is
      // already on screen and selectable, so there's nothing to recover from.
    }
  }, [generatedConfigJson]);

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

  const pickExtraGiftOptions = async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      filter: { variants: false, archived: false },
    });
    if (!selection || selection.length === 0) return;
    const primaryId = String(builder.product_id || "").trim();
    const mapped = selection.map((product) => {
      const image =
        product.images?.[0]?.originalSrc ||
        product.images?.[0]?.src ||
        product.images?.[0]?.url ||
        "";
      const rawPrice = product.variants?.[0]?.price;
      const priceAmount =
        typeof rawPrice === "string" ? rawPrice : rawPrice?.amount ?? "";
      return {
        product_id: extractNumericId(product.id),
        product_title: product.title,
        product_image: image,
        product_price: priceAmount ? `$${Number(priceAmount).toFixed(2)}` : "",
      };
    });
    setBuilder((prev) => {
      const existing = Array.isArray(prev.extra_gift_options)
        ? prev.extra_gift_options
        : [];
      const seen = new Set(
        [primaryId, ...existing.map((o) => String(o.product_id))].filter(Boolean),
      );
      const additions = mapped.filter((o) => {
        const id = String(o.product_id);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      return { ...prev, extra_gift_options: [...existing, ...additions] };
    });
  };

  const removeExtraGiftOption = (productId) =>
    setBuilder((prev) => ({
      ...prev,
      extra_gift_options: (prev.extra_gift_options || []).filter(
        (o) => String(o.product_id) !== String(productId),
      ),
    }));

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

  // Deep link: /app/gift-with-purchase?config=<rowId> opens that saved config in
  // the editor. Also accepts a discount id (gid or numeric) so the per-discount
  // details page can link "edit this offer" without knowing the row id. The
  // param stays in the URL so the link is shareable; it's only applied on mount.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const target = String(searchParams.get("config") || "").trim();
    if (!target) return;
    const targetNumeric = target.match(/(\d+)$/)?.[1] ?? null;
    const row = saved.find(
      (r) =>
        r.id === target ||
        (r.discountId &&
          (r.discountId === target ||
            (targetNumeric && r.discountId.endsWith(`/${targetNumeric}`)))),
    );
    if (row) {
      loadSaved(row);
    } else {
      shopify.toast.show("Saved config not found for that link", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const submitDiscountIntent = (intent, id) => {
    const formData = new FormData();
    formData.set("intent", intent);
    formData.set("id", id);
    fetcher.submit(formData, { method: "POST" });
  };

  const tabs = [
    {
      id: "saved",
      content: `Saved${saved.length > 0 ? ` (${saved.length})` : ""}`,
      panelID: "saved-panel",
    },
    { id: "builder", content: "Builder", panelID: "builder-panel" },
  ];

  const showProductTag = builder.trigger_type !== "subscription";
  const showMinSpend = triggerUsesMinSpend(builder.trigger_type);
  const showBuyXHint = builder.trigger_type === "buy_x_and_min_spend";
  const showRedeemedTag = builder.redemption_type === "one_per_customer";

  return (
    <Page>
      <TitleBar title="Gift With Purchase">
        {/* App Bridge renders these in the admin top bar, so save actions stay
            visible however far down the builder form the user has scrolled. */}
        {selectedTab === 1 && (
          <>
            <button variant="breadcrumb" onClick={() => setSelectedTab(0)}>
              Saved configs
            </button>
            {editingId && (
              <button onClick={saveNew} disabled={isSaving}>
                Save as new
              </button>
            )}
            <button
              variant="primary"
              onClick={editingId ? updateExisting : saveNew}
              disabled={isSaving}
            >
              {editingId ? "Update" : "Save"}
            </button>
          </>
        )}
      </TitleBar>
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

                    <TextField
                      label="Description"
                      value={builder.description}
                      onChange={(v) => update("description", v)}
                      autoComplete="off"
                      multiline={2}
                      placeholder="e.g. Victoriana launch - free robe with any Victoriana piece over $300"
                      helpText="Optional internal note about what this promotion is for. Shown with the config in Saved, never to customers."
                    />

                    <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                      <BlockStack gap="150">
                        <Text as="h3" variant="headingSm">
                          Summary of this offer
                        </Text>
                        {builderSummary.map((line, i) => (
                          <Text key={i} as="p" variant="bodySm">
                            {renderSummaryLine(line)}
                          </Text>
                        ))}
                      </BlockStack>
                    </Box>

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
                      label="Add to cart behavior"
                      options={[
                        { label: "Auto-add (added automatically)", value: "auto" },
                        { label: "Manual (customer taps to add)", value: "manual" },
                      ]}
                      value={builder.add_mode}
                      onChange={(v) => update("add_mode", v === "manual" ? "manual" : "auto")}
                      helpText={
                        builder.extra_gift_options.length > 0
                          ? "Ignored while there are multiple gift options - the customer always picks one and adds it manually."
                          : "Auto-add drops the gift in the cart as soon as the customer qualifies and blocks checkout until it's there. Manual shows an optional 'Add gift' button the customer can skip."
                      }
                    />

                    <Checkbox
                      label="Auto-remove gift when not eligible"
                      checked={builder.auto_remove_gift}
                      onChange={(v) => update("auto_remove_gift", v)}
                      helpText="When off (default), a gift product the customer added themselves stays in their cart even before they hit the threshold - so they can buy it outright or redeem it at the discount once they qualify. When on, the checkout strips the gift product whenever the customer isn't currently eligible. Gifts the app auto-added are always tidied up either way."
                    />

                    <Select
                      label="Trigger type"
                      options={TRIGGER_TYPES}
                      value={builder.trigger_type}
                      onChange={(v) => update("trigger_type", v)}
                      helpText="Picks the rule that unlocks the gift. Buy X + min spend requires both a tagged product in the cart and the spend threshold."
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
                      label="Discount title"
                      value={builder.discount_title}
                      onChange={(v) => update("discount_title", v)}
                      autoComplete="off"
                      placeholder="e.g. Gift with purchase - Luna"
                      helpText="Title of the automatic discount this config creates, shown in the Shopify admin Discounts list. Leave blank to use the config name."
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
                            : builder.trigger_type === "buy_x_and_min_spend"
                              ? "The customer must have at least one product carrying this tag in the cart. It does NOT narrow the spend threshold - that's measured across the whole cart. Required: a blank tag never qualifies."
                              : "Cart lines whose product carries this tag count toward the trigger."
                        }
                      />
                    )}

                    {showBuyXHint && (
                      <TextField
                        label="Progress hint when the tagged product is missing"
                        value={builder.banner_buy_x_hint}
                        onChange={(v) => update("banner_buy_x_hint", v)}
                        autoComplete="off"
                        placeholder="e.g. Add a Victoriana piece to unlock this offer"
                        helpText="Shown under the progress bar while the cart has no product carrying the tag above."
                      />
                    )}

                    {showMinSpend && (
                      <>
                        <Divider />
                        <Text as="h3" variant="headingSm">
                          Min spend thresholds
                        </Text>
                        {builder.trigger_type === "buy_x_and_min_spend" && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            Measured across the whole cart, excluding gift cards and the gift itself.
                          </Text>
                        )}
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
                              {numericId ? (
                                <Button
                                  url={`shopify://admin/products/${numericId}`}
                                  target="_blank"
                                  variant="plain"
                                >
                                  Open product
                                </Button>
                              ) : null}
                            </InlineStack>
                          ) : (
                            <Text as="span" variant="bodyMd" tone="subdued">
                              No product selected
                            </Text>
                          )}
                        </InlineStack>
                      );
                    })()}
                    <Divider />
                    <Text as="h3" variant="headingSm">
                      More gift options (customer picks one)
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Add extra products to let the customer choose one free gift
                      from several. The gift above is the first option. With two
                      or more options the customer always picks one in checkout
                      (the Add to cart behavior setting is ignored).
                    </Text>
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <Button onClick={pickExtraGiftOptions}>Add gift options</Button>
                      {builder.extra_gift_options.length === 0 ? (
                        <Text as="span" variant="bodyMd" tone="subdued">
                          No extra options (single gift)
                        </Text>
                      ) : null}
                    </InlineStack>
                    {builder.extra_gift_options.length > 0 ? (
                      <BlockStack gap="200">
                        {builder.extra_gift_options.map((opt) => {
                          const numericId =
                            String(opt.product_id).match(/\/(\d+)$/)?.[1] ??
                            String(opt.product_id);
                          const info = numericId ? productInfo[numericId] : undefined;
                          const title = opt.product_title || info?.title || "";
                          const image = opt.product_image || info?.imageUrl || "";
                          const price = opt.product_price || info?.price || "";
                          return (
                            <InlineStack
                              key={opt.product_id}
                              gap="300"
                              blockAlign="center"
                              align="space-between"
                              wrap={false}
                            >
                              <InlineStack gap="300" blockAlign="center" wrap={false}>
                                {image ? (
                                  <Thumbnail source={image} alt={title || "Gift"} size="small" />
                                ) : null}
                                <BlockStack gap="050">
                                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                                    {title || "Product"}
                                  </Text>
                                  {price ? (
                                    <Text as="span" variant="bodySm">
                                      {price}
                                    </Text>
                                  ) : null}
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    ID: {opt.product_id}
                                  </Text>
                                </BlockStack>
                              </InlineStack>
                              <Button
                                tone="critical"
                                variant="tertiary"
                                onClick={() => removeExtraGiftOption(opt.product_id)}
                              >
                                Remove
                              </Button>
                            </InlineStack>
                          );
                        })}
                      </BlockStack>
                    ) : null}

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
                    <TextField
                      label="Maximum total uses"
                      type="number"
                      min={0}
                      value={builder.max_total_uses}
                      onChange={(v) => update("max_total_uses", v)}
                      autoComplete="off"
                      placeholder="Leave blank for unlimited"
                      helpText="Cap on how many times this gift's discount can be used in total. Once reached, the app deactivates the discount and checkout shows the sold-out message. Blank or 0 = unlimited. Note: the used count updates asynchronously, so a small overshoot near the cap is possible."
                    />

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Customer eligibility
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Who the discount applies to in Shopify. Use Specific
                      customers to restrict it to your team&apos;s emails while
                      testing.
                    </Text>
                    <Select
                      label="Eligibility"
                      labelHidden
                      options={[
                        { label: "All customers", value: "all" },
                        { label: "Specific customers", value: "customers" },
                        { label: "Specific customer segments", value: "segments" },
                      ]}
                      value={builder.eligibility}
                      onChange={(v) => update("eligibility", v)}
                    />
                    {builder.eligibility === "customers" ? (
                      <TextField
                        label="Eligible customer emails"
                        value={builder.eligible_emails}
                        onChange={(v) => update("eligible_emails", v)}
                        autoComplete="off"
                        multiline={3}
                        placeholder={"jane@honeybirdette.com\njohn@honeybirdette.com"}
                        helpText="One email per line. Each must already be a customer in this shop; unknown emails are skipped."
                      />
                    ) : null}
                    {builder.eligibility === "segments" ? (
                      segments && segments.length > 0 ? (
                        <ChoiceList
                          allowMultiple
                          title="Customer segments"
                          choices={segments.map((s) => ({
                            label: s.name,
                            value: s.id,
                          }))}
                          selected={builder.eligible_segments}
                          onChange={(v) => update("eligible_segments", v)}
                        />
                      ) : (
                        <Text as="p" variant="bodySm" tone="subdued">
                          No customer segments found in this shop. Create one in
                          Shopify admin, or use Specific customers instead.
                        </Text>
                      )
                    ) : null}

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Combinations
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Which other discount types this gift's automatic discount
                      can combine with. Applied to the discount in Shopify.
                    </Text>
                    <Checkbox
                      label="Combine with product discounts"
                      checked={builder.combines_product}
                      onChange={(v) => update("combines_product", v)}
                    />
                    <Checkbox
                      label="Combine with order discounts"
                      checked={builder.combines_order}
                      onChange={(v) => update("combines_order", v)}
                    />
                    <Checkbox
                      label="Combine with shipping discounts"
                      checked={builder.combines_shipping}
                      onChange={(v) => update("combines_shipping", v)}
                    />

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Schedule (optional)
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Sets the discount&apos;s active start/end dates in Shopify.
                      Times are interpreted in {tzLabel}.
                    </Text>
                    <FormLayout.Group>
                      <TextField
                        label="Valid from"
                        type="datetime-local"
                        value={builder.valid_from}
                        onChange={(v) => update("valid_from", v)}
                        autoComplete="off"
                        helpText={`Leave blank to start immediately. Interpreted as ${tzLabel} time.`}
                      />
                      <TextField
                        label="Valid to"
                        type="datetime-local"
                        value={builder.valid_to}
                        onChange={(v) => update("valid_to", v)}
                        autoComplete="off"
                        helpText={`Leave blank for no end. Interpreted as ${tzLabel} time.`}
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
                      label="Subtitle"
                      value={builder.banner_subtitle}
                      onChange={(v) => update("banner_subtitle", v)}
                      autoComplete="off"
                      helpText="Optional line shown under the section heading across all states (subdued, like the recommendations subtitle). Blank = hidden."
                    />
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
                      Banner copy - unlocked (gift not yet in cart)
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Shown once the customer qualifies. For manual / pick-one
                      offers this is the prompt next to the Add button, so word it
                      as the offer (e.g. &quot;Add Luna to your cart to receive 50%
                      off&quot;).
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
                      Banner copy - gift added to cart
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Shown once the gift is in the cart - the confirmation state.
                      Leave blank to reuse the &quot;unlocked&quot; copy above.
                    </Text>
                    <TextField
                      label="Title"
                      value={builder.banner_title_added}
                      onChange={(v) => update("banner_title_added", v)}
                      autoComplete="off"
                    />
                    <TextField
                      label="Message"
                      value={builder.banner_message_added}
                      onChange={(v) => update("banner_message_added", v)}
                      autoComplete="off"
                      multiline={2}
                      helpText="Supports {{ title }} (gift product name)."
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
              {/* Sticks to the top of the viewport as the long builder form
                  scrolls past, so Save is always reachable. */}
              <div style={{ position: "sticky", top: "var(--p-space-400)" }}>
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

                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h2" variant="headingMd">
                          Config JSON
                        </Text>
                        <Button onClick={copyConfigJson} variant="plain">
                          {jsonCopied ? "Copied" : "Copy"}
                        </Button>
                      </InlineStack>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Live preview of what this builder will save, including any
                        unsaved edits. Paste it into a bug report.
                      </Text>
                      <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                        {/* Box has no maxHeight prop, so the scroll container is
                            this div: a tall config would otherwise push the whole
                            sticky column past the viewport. */}
                        <div style={{ maxHeight: "24rem", overflow: "auto" }}>
                          <pre
                            style={{
                              margin: 0,
                              fontFamily: "var(--p-font-family-mono)",
                              fontSize: "var(--p-font-size-275)",
                              lineHeight: "var(--p-font-line-height-400)",
                              whiteSpace: "pre",
                            }}
                          >
                            {generatedConfigJson}
                          </pre>
                        </div>
                      </Box>
                    </BlockStack>
                  </Card>
                </BlockStack>
              </div>
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

                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">
                      Each config owns its own automatic discount, bound to the
                      gift-with-purchase-discount function and tagged{" "}
                      <Text as="span" fontWeight="semibold">
                        AMD App
                      </Text>
                      . A config saved in{" "}
                      <Text as="span" fontWeight="semibold">
                        Test mode
                      </Text>{" "}
                      (or Disabled) has its discount created{" "}
                      <Text as="span" fontWeight="semibold">
                        deactivated
                      </Text>{" "}
                      so it never applies on real checkouts. To test safely, set{" "}
                      <Text as="span" fontWeight="semibold">
                        Customer eligibility
                      </Text>{" "}
                      to Specific customers (your team&apos;s emails), then make
                      the discount active - only those customers will get it.
                    </Text>
                  </Banner>

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
                        let description = "";
                        let parsedConfig = null;
                        try {
                          const parsed = JSON.parse(row.configJson);
                          parsedConfig = parsed;
                          if (parsed.trigger_type) trigger = parsed.trigger_type;
                          enabled = parsed.enabled !== false;
                          mode = parsed.mode === "test" ? "test" : "live";
                          productId =
                            parsed.product_id != null ? String(parsed.product_id) : "";
                          adminTitle = parsed.admin_title ?? "";
                          description = parsed.description ?? "";
                        } catch {
                          trigger = "unknown";
                        }
                        const isEditing = editingId === row.id;
                        const disc = discountMap?.[row.id] || { exists: false };
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
                              {description ? (
                                <Text as="p" variant="bodyMd">
                                  {description}
                                </Text>
                              ) : null}
                              {parsedConfig ? (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {renderSummaryLine(
                                    summarizeConfig(parsedConfig, {
                                      productInfo,
                                      segments,
                                    }).join(" "),
                                  )}
                                </Text>
                              ) : null}
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

                              {trigger !== "unknown" ? (
                                <>
                                  <Divider />
                                  <InlineStack
                                    align="space-between"
                                    blockAlign="center"
                                    gap="200"
                                  >
                                    <InlineStack gap="200" blockAlign="center">
                                      <Text as="span" variant="bodySm" fontWeight="semibold">
                                        Discount
                                      </Text>
                                      <Badge
                                        tone={
                                          disc.exists
                                            ? discountStatusTone(disc.status)
                                            : undefined
                                        }
                                      >
                                        {disc.exists
                                          ? discountStatusLabel(disc.status)
                                          : "Not created"}
                                      </Badge>
                                      {disc.exists && disc.eligibility ? (
                                        <Badge>{disc.eligibility}</Badge>
                                      ) : null}
                                      {disc.exists && disc.used != null ? (
                                        <Badge
                                          tone={
                                            disc.usageLimit &&
                                            disc.used >= disc.usageLimit
                                              ? "critical"
                                              : "info"
                                          }
                                        >
                                          {disc.usageLimit
                                            ? `Used ${disc.used} / ${disc.usageLimit}`
                                            : `Used ${disc.used} time${disc.used === 1 ? "" : "s"}`}
                                        </Badge>
                                      ) : null}
                                      {disc.exists && disc.adminUrl ? (
                                        <Link url={disc.adminUrl} target="_blank">
                                          View in Shopify admin
                                        </Link>
                                      ) : null}
                                    </InlineStack>
                                    <InlineStack gap="200">
                                      {!disc.exists ? (
                                        <Button
                                          onClick={() =>
                                            submitDiscountIntent("create_discount", row.id)
                                          }
                                          loading={isSaving}
                                        >
                                          Create discount
                                        </Button>
                                      ) : (
                                        <>
                                          <Button
                                            disabled={disc.status === "ACTIVE"}
                                            onClick={() =>
                                              submitDiscountIntent("activate_discount", row.id)
                                            }
                                            loading={isSaving}
                                          >
                                            Make active
                                          </Button>
                                          <Button
                                            tone="critical"
                                            variant="tertiary"
                                            disabled={disc.status !== "ACTIVE"}
                                            onClick={() =>
                                              submitDiscountIntent("deactivate_discount", row.id)
                                            }
                                            loading={isSaving}
                                          >
                                            Deactivate
                                          </Button>
                                        </>
                                      )}
                                    </InlineStack>
                                  </InlineStack>
                                </>
                              ) : null}
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
