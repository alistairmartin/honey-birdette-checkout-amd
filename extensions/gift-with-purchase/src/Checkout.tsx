import React, {useEffect, useMemo, useRef, useState} from "react";
import {
  reactExtension,
  Banner,
  Badge,
  BlockStack,
  Heading,
  Text,
  Button,
  InlineStack,
  InlineLayout,
  Image,
  View,
  Progress,
  useApi,
  useAttributes,
  useApplyCartLinesChange,
  useBuyerJourneyIntercept,
  useCheckoutSettings,
  useExtensionEditor,
  useCartLines,
  useAppMetafields,
  useCustomer,
  useEmail,
  useSettings,
  useTranslate,
  useLocalizationMarket,
  useDiscountAllocations,
} from "@shopify/ui-extensions-react/checkout";

// GWP: configs are no longer pasted into an extension setting. Instead the
// "Gift With Purchase" admin page saves each config and pushes the full set
// up to a SHOP metafield ($app:gift-with-purchase / configs). This extension
// reads that metafield via the storefront API and renders one independent gift
// offer per enabled config. Each config object looks like:
// {
//   "enabled": true,
//   "trigger_type": "min_spend",
//   "product_tag": "new-spf",
//   "min_spend_AUD": 250,
//   "min_spend_GBP": 150,
//   "min_spend_USD": 300,
//   "min_spend_EUR": 200,
//   "min_spend_currency": "AUD", // one of AUD, USD, GBP, EUR
//   "product_id": 7085879689350,
//   "shipping_countries": "Australia,New Zealand",
//   "customer_redeemed_tag": "redeemed_holiday_bag",
//   "button_url": "https://gotoskincare.com/collections/shop-all",
//   "button_text": "Go to collection",
//   "banner_title_before": "You're close!",
//   "banner_message_before": "Spend {{ remaining }} more to get a FREE {{ title }}.",
//   "banner_title_after": "You've Got Your FREE GIFT",
//   "banner_message_after": "Your free Fancy Face Mini has been added.",
//   "banner_title_redeemed": "You've already redeemed Fancy Face Mini gift.",
//   "banner_message_redeemed": "Sorry, you've already redeemed. One Per Customer.",
//   "banner_title_region": "Sorry this gift is not available in your region.",
//   "banner_message_region": "Sorry, we are only shipping this gift to {{ allowed }}."
// }

export default reactExtension("purchase.checkout.block.render", () => <Extension />);

// Honey Birdette runs in seven currencies. Per-config min_spend_* thresholds and
// the active-currency detection below are all keyed on this set.
type Currency = "AUD" | "NZD" | "USD" | "CAD" | "GBP" | "EUR" | "AED";
const SUPPORTED_CURRENCIES: Currency[] = [
  "AUD",
  "NZD",
  "USD",
  "CAD",
  "GBP",
  "EUR",
  "AED",
];
// Country used for each currency's @inContext pricing query.
const COUNTRY_BY_CURRENCY: Record<Currency, string> = {
  AUD: "AU",
  NZD: "NZ",
  USD: "US",
  CAD: "CA",
  GBP: "GB",
  EUR: "DE",
  AED: "AE",
};

// Storefront-API read of the shop metafield the admin page writes to.
const CONFIG_QUERY = `#graphql
  query GiftWithPurchaseConfigs {
    shop {
      metafield(namespace: "$app:gift-with-purchase", key: "configs") {
        value
      }
    }
  }
`;

// Parse the metafield JSON ({ configs: [...] }) into a plain config array.
function parseConfigsFromMetafield(raw: unknown): any[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(payload?.configs) ? payload.configs : [];
  return list.filter((c: any) => c && typeof c === "object");
}

// Pull the store timezone the app wrote into the metafield ({ timeZone }).
// Falls back to '' so callers can apply their own default.
function parseTimeZoneFromMetafield(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const tz = JSON.parse(raw)?.timeZone;
    return typeof tz === "string" ? tz : "";
  } catch {
    return "";
  }
}

// Parent: load all configs from the metafield and render one GiftOffer per
// enabled config. Each GiftOffer owns its own hooks, cart sync, and checkout
// intercept, so multiple gifts run side by side without interfering.
function Extension() {
  const { query, extension } = useApi();
  // Hide the whole GWP block on draft-order checkouts (e.g. a merchant-created
  // invoice). Draft orders have un-editable cart lines/discounts, so the gift
  // auto-add and its buyer-journey block can't work; showing the offer would
  // just confuse the buyer. `orderSubmission` is 'DRAFT_ORDER' vs 'ORDER'.
  const checkoutSettings = useCheckoutSettings();
  const isDraftOrder = checkoutSettings?.orderSubmission === "DRAFT_ORDER";
  // Also hide on Honey List gift checkouts (Order A). Line items aren't exposed
  // to extensions there (cart lines come back empty on a draft-order invoice, and
  // `_`-prefixed line attributes are stripped), so we key off the order-level
  // `honey_list` marker the Honey List app stamps on the draft (ORDER_ATTR in
  // that app's config). Order-level attributes are the only reliable channel.
  // `honey_list` is the purpose-built marker; `hl_*` (e.g. `hl_gift_owner`, which
  // the checkout banner relies on) is always present too. Match either so this
  // fires regardless of which Honey List app version is deployed.
  const orderAttributes = useAttributes();
  const isHoneyListCheckout = (orderAttributes || []).some(
    (a) => a?.key === "honey_list" || (typeof a?.key === "string" && a.key.startsWith("hl_")),
  );
  // Defined when rendering inside the Checkout Editor preview; undefined on the
  // live storefront. Used to gate test-mode configs.
  const editor = useExtensionEditor();
  const inEditor = Boolean(editor);
  // `extension.version` is undefined for an unpublished extension target (dev,
  // preview, or a draft/unpublished checkout profile) and a version string once
  // the extension is deployed and published. We treat "no version" as an
  // unpublished checkout for the purpose of showing test-mode configs.
  const isUnpublished = !extension?.version;
  // Per-block override: when the merchant enables this in the checkout editor
  // block settings, test-mode configs render even on a published checkout
  // (handy for QA on the live profile).
  const { show_test_mode_configs } = useSettings();
  const showTestConfigs = inEditor || isUnpublished || Boolean(show_test_mode_configs);
  const [configs, setConfigs] = useState<any[]>([]);
  const [storeTimeZone, setStoreTimeZone] = useState<string>("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res: any = await query(CONFIG_QUERY);
        if (cancelled) return;
        const raw = res?.data?.shop?.metafield?.value;
        setConfigs(parseConfigsFromMetafield(raw));
        setStoreTimeZone(parseTimeZoneFromMetafield(raw));
      } catch (err) {
        if (!cancelled) console.error("GWP: failed to load configs", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (!loaded) return null;
  if (isDraftOrder || isHoneyListCheckout) return null;

  const activeConfigs = configs.filter((c) => {
    if (c?.enabled === false) return false;
    // Test-mode configs render only on an unpublished checkout (editor preview
    // or undeployed extension version), OR when the block's
    // `show_test_mode_configs` setting is enabled. They never show on a
    // published checkout otherwise.
    const isTest = String(c?.mode || "live").toLowerCase() === "test";
    return !isTest || showTestConfigs;
  });
  if (activeConfigs.length === 0) return null;

  return (
    <BlockStack>
      {activeConfigs.map((cfg, i) => (
        <GiftOffer
          key={String(cfg?.admin_title || cfg?.product_id || cfg?.customer_redeemed_tag || i)}
          config={cfg}
          storeTimeZone={storeTimeZone}
        />
      ))}
    </BlockStack>
  );
}

// Small helper to coerce either raw number ID or gid into a variant gid
function toVariantGid(idLike: string | number): string {
  const asStr = String(idLike).trim();
  if (asStr.startsWith("gid://")) return asStr; // assume already a GID
  // assume it's a numeric ProductVariant ID
  return `gid://shopify/ProductVariant/${asStr}`;
}

// Map common country names -> ISO2
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  "australia": "AU",
  "new zealand": "NZ",
  "united states": "US",
  "united kingdom": "GB",
  // add more if you need later
};

// Shopify Market ID for the EU market. The optional "EU" token in a config's
// shipping_countries list qualifies a shopper only when this is their market.
// Set this to Honey Birdette's EU market id if you use the "EU" token; otherwise
// use plain ISO country codes (e.g. DE,FR,IE) and this can stay unused.
const EU_MARKET_ID = "";

type AllowedCountries = {
  names: string[]; // free-text tokens that weren't a 2-letter code or EU
  iso2: string[]; // direct ISO2 codes, plus codes mapped from known names
  wantsEU: boolean; // "EU" token present -> match the EU market
  all: boolean; // "all" token present -> everyone qualifies
};

// Accepts a comma-separated mix of ISO2 codes (AU, NZ, US, GB), country names
// (Australia, New Zealand), the special token "EU" (EU market), and "all".
function parseAllowedCountries(input: string | undefined | null): AllowedCountries {
  const result: AllowedCountries = { names: [], iso2: [], wantsEU: false, all: false };
  if (!input) return result;
  for (const raw of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    const up = raw.toUpperCase();
    if (up === "ALL") {
      result.all = true;
    } else if (up === "EU") {
      result.wantsEU = true;
    } else if (/^[A-Z]{2}$/.test(up)) {
      result.iso2.push(up);
    } else {
      result.names.push(raw);
      const mapped = COUNTRY_NAME_TO_ISO2[raw.toLowerCase()];
      if (mapped) result.iso2.push(mapped);
    }
  }
  return result;
}

// Human-readable list of what's allowed, for the {{ allowed }} banner var.
function describeAllowedCountries(a: AllowedCountries): string {
  const parts = [...a.names, ...a.iso2];
  if (a.wantsEU) parts.push("EU");
  return Array.from(new Set(parts)).join(", ");
}

function safeParseJSON<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (_e) {
    return fallback;
  }
}

// Fetch product tags and prices for cart variants in a given currency's pricing
// context. One templated query per supported currency so cart-line prices come
// back in the buyer's active currency (single query, no Promise.all fan-out).
function buildVariantTagsQuery(country: string): string {
  return `#graphql
    query VariantProductTagsAndPrices($ids: [ID!]!) @inContext(country: ${country}) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price { amount currencyCode }
          product { id tags isGiftCard }
        }
      }
    }
  `;
}

const QUERY_BY_CURRENCY: Record<Currency, string> = SUPPORTED_CURRENCIES.reduce(
  (acc, cur) => {
    acc[cur] = buildVariantTagsQuery(COUNTRY_BY_CURRENCY[cur]);
    return acc;
  },
  {} as Record<Currency, string>,
);

// Currency-aware resolver for gift options. Returns the variant to add plus the
// title/image/price used to render the "pick one" cards in the buyer's currency.
function buildGiftResolveQuery(country: string): string {
  return `#graphql
    query GiftResolve($id: ID!) @inContext(country: ${country}) {
      node(id: $id) {
        __typename
        ... on ProductVariant {
          id
          availableForSale
          price { amount currencyCode }
          image { url }
          product { title featuredImage { url } }
        }
        ... on Product {
          title
          featuredImage { url }
          variants(first: 1) {
            nodes {
              id
              availableForSale
              price { amount currencyCode }
              image { url }
            }
          }
        }
      }
    }
  `;
}

const GIFT_RESOLVE_QUERY_BY_CURRENCY: Record<Currency, string> = SUPPORTED_CURRENCIES.reduce(
  (acc, cur) => {
    acc[cur] = buildGiftResolveQuery(COUNTRY_BY_CURRENCY[cur]);
    return acc;
  },
  {} as Record<Currency, string>,
);

type ResolvedGiftOption = {
  productId: string; // the raw option id as configured (string form)
  variantGid: string | null;
  title: string | null;
  image: string | null;
  price: string | null; // pre-formatted in the active currency
  priceAmount: number | null; // raw amount, for computing the discounted price
  priceCurrency: string | null;
  available: boolean | null;
};

function formatMoney(amount: number | string, currencyCode: string = "AUD") {
  const n = Number(amount || 0);
  try {
    // No decimal places (team request): show "A$100", not "A$100.00".
    return n.toLocaleString(undefined, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  } catch (_e) {
    // Fallback if locale doesn't support the currency
    return `${currencyCode} ${Math.round(n)}`;
  }
}

function normalizeTagList(raw: string | undefined | null): string[] {
  const value = (raw ?? "").toString().trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => String(v).trim())
        .filter(Boolean);
    }
  } catch (_e) {
    // fall back to delimited string parsing
  }
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Native checkout progress bar. `Progress` takes a 0..max value (max defaults
// to 1), so we feed it the completion fraction. The accessibility label keeps
// the percentage available to screen readers now that the visual bar no longer
// prints "34%" as text.
function ProgressBar({percent}: {percent: number}) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <Progress
      value={pct}
      max={100}
      accessibilityLabel={`${pct}% of the way to your free gift`}
    />
  );
}

// Square-cornered outlined label used for the offer pill (e.g. "LIMITED
// OFFER"). The checkout `Badge` renders as a rounded pill; the team asked us to
// square it up to match the storefront tag, so we render our own bordered View
// with square corners instead. Wrapped in an InlineStack so it shrinks to its
// content rather than stretching the full row width.
// Small inline pill used to flag the offer (e.g. "LIMITED OFFER"). Uses the
// native Badge component, left-aligned so it hugs its content.
function OfferBadge({children}: {children: string}) {
  return (
    <InlineStack inlineAlignment="start">
      <Badge>{children}</Badge>
    </InlineStack>
  );
}

// Lightweight section wrapper used instead of Banner for the offer states.
// Mirrors the checkout recommendations header: an uppercase heading with an
// optional subdued subtitle beneath it, over the offer content. No banner
// chrome or status icon.
function Section({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <BlockStack spacing="tight">
      {title || subtitle ? (
        <BlockStack spacing="tight">
          {title ? <Heading>{title.toUpperCase()}</Heading> : null}
          {subtitle ? <Text appearance="subdued">{subtitle}</Text> : null}
        </BlockStack>
      ) : null}
      {children}
    </BlockStack>
  );
}

function GiftOffer({config: rawConfig, storeTimeZone}: {config: any; storeTimeZone?: string}) {
  const t = useTranslate();
  const {extension} = useApi();
  const applyCartLinesChange = useApplyCartLinesChange();
  const lines = useCartLines();

  // Get cart-level discount allocations (for order discounts)
  const discountAllocations = useDiscountAllocations();

  // Load customer metafields for redemption tracking (from V1)
  const appMetafields = useAppMetafields();
  const customerTagMetafields = useAppMetafields({
    type: 'customer',
    namespace: 'custom',
    key: 'tags',
  });

  let customer: ReturnType<typeof useCustomer> | undefined;
  let customerError: unknown;
  try {
    customer = useCustomer();
  } catch (err) {
    customerError = err;
  }
  const customerErrorMessage =
    customerError instanceof Error ? customerError.message : customerError ? String(customerError) : "";

  const {shippingAddress, query} = useApi();

  // Config comes from the shop metafield (one object per gift), passed in by the
  // parent. Banner visibility is per-config; only the debug toggle is global.
  const {show_testing_information} = useSettings();

  // Pull localization from Standard API (currency, language, country)
  const { localization: apiLocalization } = useApi();

  // Localization hooks: use Market (handle/id) for overrides; use API localization for currency
  const market = useLocalizationMarket();
  const detectedCurrencyIso = (apiLocalization?.currency?.isoCode || "").toUpperCase();

  // Normalize Market ID (Shopify returns a GID e.g. gid://shopify/Market/4720590982)
  const marketIdRaw = String(market?.id || "");
  const marketIdNumeric = marketIdRaw.split("/").pop() || marketIdRaw;

  // Currency is taken from the buyer's checkout currency (apiLocalization), not
  // from a hardcoded Market-ID map. marketIdNumeric is still used below only for
  // the "EU" shipping-country token.

const config = useMemo(() => {
  const cfg = (rawConfig && typeof rawConfig === "object" ? rawConfig : {}) as any;
  const rawTrigger = String(cfg.trigger_type || "min_spend").toLowerCase();
  const trigger_type: "min_spend" | "subscription" | "buy_x_get_y" | "buy_x_and_min_spend" =
    rawTrigger === "subscription" || rawTrigger === "buy_x_get_y" || rawTrigger === "buy_x_and_min_spend"
      ? rawTrigger
      : "min_spend";
  const mode: "live" | "test" = String(cfg.mode || "live").toLowerCase() === "test" ? "test" : "live";
  // Redemption limit. "one_per_order" disables the per-customer redeemed-tag
  // check entirely; "one_per_customer" enforces it via the tag. Configs from
  // before this field existed are inferred from the presence of a tag.
  const redemption_type: "one_per_order" | "one_per_customer" =
    String(cfg.redemption_type || (cfg.customer_redeemed_tag ? "one_per_customer" : "one_per_order")).toLowerCase() ===
    "one_per_customer"
      ? "one_per_customer"
      : "one_per_order";
  return {
    enabled: Boolean(cfg.enabled),
    mode,
    trigger_type,
    redemption_type,
    // "auto" drops the gift in the cart on qualify and blocks checkout until it's
    // there; "manual" shows an optional add button the customer can skip. Forced
    // to manual-style behaviour whenever there are multiple gift options.
    add_mode: (String(cfg.add_mode || "auto").toLowerCase() === "manual"
      ? "manual"
      : "auto") as "auto" | "manual",
    // When true, the extension strips the gift product out of the cart whenever
    // the customer isn't currently eligible (under threshold, redeemed, wrong
    // region, sold out). Default false so a shopper who added the product
    // themselves (e.g. buying it outright, or to redeem at a discount once they
    // hit the threshold) keeps it in their cart. Note: gift lines the app itself
    // added (carrying the `_promo` attribute) are always cleaned up regardless,
    // so free-gift offers still tidy up after themselves.
    auto_remove_gift: Boolean(cfg.auto_remove_gift),
    // The customer-picks-one set. The admin writes the primary gift as element 0
    // plus any extras; only present when there are 2+ options.
    gift_options: Array.isArray(cfg.gift_options)
      ? cfg.gift_options
          .map((o: any) => (o && typeof o === "object" ? o.product_id : o))
          .filter((id: any) => id != null && id !== "")
      : [],
    admin_title: String(cfg.admin_title || "").trim(),
    // Short label shown as a pill above the progress banner (e.g. "LIMITED OFFER").
    label: String(cfg.label || "").trim(),
    product_tag: String(cfg.product_tag || "").trim(),
    min_spend: Number(cfg.min_spend || 0),
    min_spend_AUD: Number(cfg.min_spend_AUD ?? cfg.min_spend ?? 0),
    min_spend_NZD: Number(cfg.min_spend_NZD ?? 0),
    min_spend_USD: Number(cfg.min_spend_USD ?? 0),
    min_spend_CAD: Number(cfg.min_spend_CAD ?? 0),
    min_spend_GBP: Number(cfg.min_spend_GBP ?? 0),
    min_spend_EUR: Number(cfg.min_spend_EUR ?? 0),
    min_spend_AED: Number(cfg.min_spend_AED ?? 0),
    min_spend_currency: (String(cfg.min_spend_currency || "AUD").toUpperCase() as Currency),
    // Passed through to the discount function via the metafield; not used by the
    // extension UI directly (the function makes the gift line free / % off).
    discount_percentage: Number(cfg.discount_percentage ?? 100),
    // DB row id the app stamps onto each config in the shop metafield, used to
    // ask the backend for this offer's discount usage (sold-out gate).
    config_id: String(cfg.id || "").trim(),
    // Cap on total discount uses. 0 = unlimited. The backend enforces the hard
    // stop (deactivates the discount); this drives the checkout sold-out state.
    max_total_uses: Number(cfg.max_total_uses || 0),
    product_id: cfg.product_id, // can be gid or numeric
    shipping_countries: String(cfg.shipping_countries || ""),
    // Only honour the redeemed tag in one-per-customer mode. Blanking it here
    // disables every downstream redemption check in one go.
    customer_redeemed_tag:
      redemption_type === "one_per_customer" ? String(cfg.customer_redeemed_tag || "").trim() : "",

    // Validity window
    valid_date_from: String(cfg.valid_date_from || '').trim(),
    valid_time_from: String(cfg.valid_time_from || '').trim(),
    valid_date_till: String(cfg.valid_date_till || '').trim(),
    valid_time_till: String(cfg.valid_time_till || '').trim(),
    // store_timezone removed; we always use Australia/Melbourne

    // NEW
    button_url: String(cfg.button_url || "").trim(),
    button_text: String(cfg.button_text || "").trim(),

    banner_title_before: String(cfg.banner_title_before || "").trim(),
    banner_message_before: String(cfg.banner_message_before || "").trim(),
    // Optional subtitle shown directly under the section heading, styled to
    // match the checkout recommendations subtitle (subdued text under the
    // heading). Blank = no subtitle line.
    banner_subtitle: String(cfg.banner_subtitle || "").trim(),
    // buy_x_and_min_spend only: line shown under the progress bar while the cart
    // still has no product carrying `product_tag`.
    banner_buy_x_hint: String(cfg.banner_buy_x_hint || "").trim(),
    banner_title_after: String(cfg.banner_title_after || "").trim(),
    banner_message_after: String(cfg.banner_message_after || "").trim(),
    // Distinct "gift is now in the cart" confirmation state. Falls back to the
    // unlocked/after copy when blank so older configs are unaffected.
    banner_title_added: String(cfg.banner_title_added || "").trim(),
    banner_message_added: String(cfg.banner_message_added || "").trim(),
    banner_title_redeemed: String(cfg.banner_title_redeemed || "").trim(),
    banner_message_redeemed: String(cfg.banner_message_redeemed || "").trim(),
    banner_title_region: String(cfg.banner_title_region || "").trim(),
    banner_message_region: String(cfg.banner_message_region || "").trim(),
    cart_message: String(cfg.cart_message || "").trim(),
    banner_title_sold_out: String(cfg.banner_title_sold_out || "Sold out").trim(),
    sold_out_message: String(cfg.sold_out_message || "Sorry, sold out.").trim(),
    // Banner visibility is per-config; default to "on" when the config is silent.
    show_banners: typeof cfg.show_banners === 'boolean' ? cfg.show_banners : true,
    show_success_banner:
      typeof cfg.show_success_banner === 'boolean' ? cfg.show_success_banner : true,
    show_testing_information: typeof show_testing_information === 'boolean' ? Boolean(show_testing_information) : Boolean(cfg.show_testing_information),
  };
}, [rawConfig, show_testing_information]);
  // Use a constant store timezone (Australia/Melbourne)
  // Store timezone the offer's valid-date/time fields are expressed in. Comes
  // from the app (shop.ianaTimezone, written into the configs metafield); falls
  // back to Australia/Melbourne if absent so older metafields still work.
  const STORE_TIMEZONE = storeTimeZone || 'Australia/Melbourne';

// Generic template renderer. Always provides `trigger_type` and aliases
// `free_gift` to whatever `title` was passed, so both {{ title }} and
// {{ free_gift }} work in any string (titles, messages, admin_title).
function renderTemplate(tpl: string, vars: Record<string, string>) {
  const merged: Record<string, string> = {
    trigger_type: config.trigger_type,
    ...vars,
  };
  if (merged.title != null && merged.free_gift == null) merged.free_gift = merged.title;
  return Object.keys(merged).reduce((out, key) => {
    const re = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    return out.replace(re, merged[key] ?? '');
  }, tpl);
}

  // --- Validity window helpers (uses store time if provided) ---
  function parseDateParts(dateStr: string): {y:number;m:number;d:number}|null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  function parseTimeParts(timeStr: string): {hh:number;mm:number}|null {
    const m = /^(\d{2}):(\d{2})$/.exec(timeStr || '');
    if (!m) return null;
    return { hh: Number(m[1]), mm: Number(m[2]) };
  }
  function nowPartsInZone(tz?: string): {y:number;m:number;d:number;hh:number;mm:number} {
    const opts: any = { timeZone: tz || undefined, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    const fmt = new Intl.DateTimeFormat('en-CA', opts).formatToParts(new Date());
    const get = (t: string) => Number(fmt.find(p => p.type === t)?.value || '0');
    return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
  }
  function toKey(y:number,m:number,d:number,hh:number,mm:number): number {
    return y*1e8 + m*1e6 + d*1e4 + hh*1e2 + mm;
  }
  function buildKeyFrom(dateStr?: string, timeStr?: string): number | null {
    const dp = dateStr ? parseDateParts(dateStr) : null;
    const tp = timeStr ? parseTimeParts(timeStr) : null;
    if (!dp && !tp) return null;
    const y = dp?.y ?? 0, m = dp?.m ?? 1, d = dp?.d ?? 1;
    const hh = tp?.hh ?? 0, mm = tp?.mm ?? 0;
    return toKey(y,m,d,hh,mm);
  }

  // Build an array of variant IDs from cart (defined later) and fetch product tags via Storefront API
  // Resolve active currency early so the tag/price fetch below can request
  // only the relevant currency context instead of fanning out to all four.
  // Fanning out caused failures: any one query rejecting via Promise.all left
  // tagData stale across cart changes, so newly added qualifying lines (e.g.
  // from the checkout upsell) were invisible to the auto-add logic and the
  // validation function then blocked checkout with no recovery path.
  const activeCurrency: Currency = ((): Currency => {
    if (SUPPORTED_CURRENCIES.includes(detectedCurrencyIso as Currency)) {
      return detectedCurrencyIso as Currency;
    }
    if (SUPPORTED_CURRENCIES.includes(config.min_spend_currency as Currency)) {
      return config.min_spend_currency as Currency;
    }
    return "AUD";
  })();

  const [tagData, setTagData] = useState<any>(null);
  const [tagsLoading, setTagsLoading] = useState<boolean>(false);
  const [tagsError, setTagsError] = useState<any>(null);

  // If feature is disabled, render nothing
  if (!config.enabled) {
    return null;
  }

  const allowedCountries = parseAllowedCountries(config.shipping_countries);
  const {names: allowedCountryNames, iso2: allowedIso2} = allowedCountries;
  const allowedDisplay = describeAllowedCountries(allowedCountries);

  // Normalized gift-option ids. With 2+ gift_options the customer picks one;
  // otherwise the single product_id is the only option.
  const optionIds = useMemo<string[]>(() => {
    const ids =
      config.gift_options.length >= 2
        ? config.gift_options
        : config.product_id != null && config.product_id !== ""
          ? [config.product_id]
          : [];
    return ids.map((v: any) => String(v).trim()).filter(Boolean);
  }, [config.gift_options, config.product_id]);

  const isMultiOption = optionIds.length >= 2;

  // When manual, the customer adds the gift themselves (and may skip it). With
  // multiple options they always pick one, so multi is implicitly manual.
  const autoAdd = config.add_mode === "auto" && !isMultiOption;

  const [resolvedOptions, setResolvedOptions] = useState<ResolvedGiftOption[]>([]);
  // The option the customer chose (multi only). For a single option the
  // effective selection is pinned to it below.
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolveOptions() {
      if (optionIds.length === 0) {
        if (!cancelled) setResolvedOptions([]);
        return;
      }
      const qStr =
        GIFT_RESOLVE_QUERY_BY_CURRENCY[activeCurrency] || GIFT_RESOLVE_QUERY_BY_CURRENCY.AUD;

      const resolveOne = async (rawStr: string): Promise<ResolvedGiftOption> => {
        const base: ResolvedGiftOption = {
          productId: rawStr,
          variantGid: null,
          title: null,
          image: null,
          price: null,
          priceAmount: null,
          priceCurrency: null,
          available: null,
        };

        // Candidate IDs to try in order (variant first when numeric/unknown).
        const candidates: string[] = [];
        if (rawStr.startsWith("gid://shopify/ProductVariant/")) {
          candidates.push(rawStr);
        } else if (rawStr.startsWith("gid://shopify/Product/")) {
          candidates.push(rawStr);
        } else if (rawStr.startsWith("gid://")) {
          candidates.push(rawStr);
        } else {
          candidates.push(`gid://shopify/ProductVariant/${rawStr}`);
          candidates.push(`gid://shopify/Product/${rawStr}`);
        }

        for (const candidate of candidates) {
          try {
            const res: any = await query(qStr, { variables: { id: candidate } });
            const node = res?.data?.node;

            if (node?.__typename === "ProductVariant" && node?.id) {
              return {
                ...base,
                variantGid: node.id,
                title: node?.product?.title ?? null,
                image: node?.image?.url ?? node?.product?.featuredImage?.url ?? null,
                price:
                  node?.price?.amount != null
                    ? formatMoney(node.price.amount, node.price.currencyCode || activeCurrency)
                    : null,
                priceAmount: node?.price?.amount != null ? Number(node.price.amount) : null,
                priceCurrency: node?.price?.currencyCode || activeCurrency,
                available:
                  typeof node?.availableForSale === "boolean" ? node.availableForSale : null,
              };
            }

            if (node?.__typename === "Product") {
              const first = node?.variants?.nodes?.find((v: any) => v?.id);
              if (first?.id) {
                return {
                  ...base,
                  variantGid: first.id,
                  title: node?.title ?? null,
                  image: first?.image?.url ?? node?.featuredImage?.url ?? null,
                  price:
                    first?.price?.amount != null
                      ? formatMoney(first.price.amount, first.price.currencyCode || activeCurrency)
                      : null,
                  priceAmount: first?.price?.amount != null ? Number(first.price.amount) : null,
                  priceCurrency: first?.price?.currencyCode || activeCurrency,
                  available:
                    typeof first?.availableForSale === "boolean" ? first.availableForSale : null,
                };
              }
            }
          } catch (_e) {
            // keep trying next candidate
          }
        }
        return base;
      };

      const resolved = await Promise.all(optionIds.map((id) => resolveOne(id)));
      if (cancelled) return;
      setResolvedOptions(resolved);
      if (!resolved.some((o) => o.variantGid)) {
        setBanner({
          status: "critical",
          message:
            "Could not resolve a variant ID from the provided gift product(s). Please provide a ProductVariant ID or a Product ID that has variants.",
        });
      }
    }

    resolveOptions();
    return () => {
      cancelled = true;
    };
  }, [query, JSON.stringify(optionIds), activeCurrency]);

  // For a single option, pin the selection to it. For multi, honour the
  // customer's pick, defaulting to whichever option is already in the cart
  // (e.g. after a page reload).
  const effectiveSelectedId = useMemo(() => {
    if (!isMultiOption) return resolvedOptions[0]?.productId ?? null;
    if (selectedProductId && resolvedOptions.some((o) => o.productId === selectedProductId)) {
      return selectedProductId;
    }
    const inCart = resolvedOptions.find(
      (o) => o.variantGid && lines.some((l) => l.merchandise.id === o.variantGid),
    );
    return inCart?.productId ?? null;
  }, [isMultiOption, resolvedOptions, selectedProductId, lines]);

  const selectedOption = useMemo(
    () => resolvedOptions.find((o) => o.productId === effectiveSelectedId) ?? null,
    [resolvedOptions, effectiveSelectedId],
  );

  // The rest of the component operates on "the selected gift", so the existing
  // single-gift machinery keeps working for both single and multi offers.
  const giftVariantGid = selectedOption?.variantGid ?? null;
  const giftTitle = selectedOption?.title ?? null;
  const giftAvailable = selectedOption?.available ?? null;

  // The resolve effect has finished (it populates one entry per configured
  // option). Until then we don't yet know whether the gift loads.
  const optionsResolved = optionIds.length > 0 && resolvedOptions.length > 0;
  // None of the configured gift products could be resolved to a buyable
  // variant via the Storefront API - e.g. the product is a draft, unpublished
  // to this sales channel, or the configured ID is wrong. Rather than show the
  // customer a technical error, we hide the whole offer (see the render gate
  // below). Still surfaced in testing mode so merchants can diagnose it.
  const giftUnresolvable = optionsResolved && !resolvedOptions.some((o) => o.variantGid);

  // Every option's variant id, for detecting/removing whichever gift is in cart.
  const optionVariantGids = useMemo(
    () => new Set(resolvedOptions.map((o) => o.variantGid).filter(Boolean) as string[]),
    [resolvedOptions],
  );

  // Is any of this offer's gift options currently in the cart?
  const anyGiftOptionInCart = useMemo(
    () => lines.some((l) => optionVariantGids.has(l.merchandise.id)),
    [lines, optionVariantGids],
  );

  // Build an array of variant IDs from cart
  const variantIds = useMemo(() => lines.map((l) => l.merchandise.id), [lines]);

  // Fetch tags and prices for cart variants in the customer's active currency
  // context. Single query (no Promise.all fan-out) so we don't lose tag data
  // for newly-added lines because of an unrelated currency context erroring.
  // Retries once on failure with a short backoff, and on hard failure clears
  // tagData so downstream logic doesn't keep operating on a stale snapshot
  // that excludes whatever line just got added.
  useEffect(() => {
    let cancelled = false;

    async function fetchTags() {
      if (!variantIds || variantIds.length === 0) {
        setTagData({nodes: []});
        setTagsError(null);
        return;
      }
      setTagsLoading(true);
      setTagsError(null);

      const queryStr = QUERY_BY_CURRENCY[activeCurrency] || QUERY_BY_CURRENCY.AUD;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (cancelled) return;
        try {
          const res: any = await query(queryStr, { variables: { ids: variantIds } });
          if (cancelled) return;
          setTagData(res?.data ?? null);
          setTagsError(null);
          setTagsLoading(false);
          return;
        } catch (err) {
          lastErr = err;
          if (attempt === 0 && !cancelled) {
            await new Promise((r) => setTimeout(r, 800));
          }
        }
      }
      if (!cancelled) {
        // Hard failure: drop stale data so the manual-button fallback can
        // detect that we don't have a reliable view of cart eligibility.
        setTagData(null);
        setTagsError(lastErr);
        setTagsLoading(false);
      }
    }
    fetchTags();
    return () => {
      cancelled = true;
    };
  }, [query, JSON.stringify(variantIds), activeCurrency]);

  // Utility: is gift currently in cart
  const isGiftInCart = useMemo(() => {
    if (!giftVariantGid) return false;
    return lines.some((l) => l.merchandise.id === giftVariantGid);
  }, [lines, giftVariantGid]);

  // Utility: remove any of this offer's gift lines if present. Targets every
  // gift option (not just the selected one) so a previously-picked gift is
  // cleaned up when the customer becomes ineligible or swaps their choice.
  //
  // By default (auto_remove_gift off) we only remove lines the app itself added
  // - those carry the `_promo=true` attribute we stamp on in tryAddGift. A line
  // the shopper added themselves (same product, but no `_promo` attribute) is
  // left in the cart so the checkout never yanks a product they chose to buy.
  // With auto_remove_gift on, any line matching a gift variant is removed.
async function removeGiftIfPresent() {
  const isPromoLine = (l: any) =>
    Array.isArray(l?.attributes) &&
    l.attributes.some((a: any) => a?.key === "_promo" && String(a?.value) === "true");
  const giftLines = lines.filter((l) => {
    if (!optionVariantGids.has(l.merchandise.id)) return false;
    return config.auto_remove_gift || isPromoLine(l);
  });
  if (giftLines.length === 0) return;
  for (const gl of giftLines) {
    const result = await applyCartLinesChange({
      type: "updateCartLine",
      id: gl.id,
      quantity: 0,
    });
    if ((result as any)?.type === "error") {
      setBanner({status: "critical", message: (result as any)?.message ?? "Failed to remove gift"});
      break;
    }
  }
}

  

  // Check: customer already redeemed? (via customer metafields custom/tags)
  const hasRedeemed = useMemo(() => {
    const target = (config.customer_redeemed_tag || '').trim().toLowerCase();
    if (!target) return false;
    if (!Array.isArray(customerTagMetafields)) return false;
    return customerTagMetafields.some((m: any) => {
      const tags = normalizeTagList(m?.metafield?.value ?? m?.value).map((tg) =>
        tg.toLowerCase()
      );
      return tags.some((tg) => tg === target);
    });
  }, [customerTagMetafields, config.customer_redeemed_tag]);

  // Defers the auto-add long enough for the customer-scoped metafield to load.
  // Why: `useAppMetafields` returns [] both when "still loading" and when
  // "loaded but absent" - indistinguishable. Without this gate, a logged-in
  // redeemed customer briefly sees hasRedeemed=false on first render, the gift
  // auto-adds, and only then the metafield arrives and we have to remove it.
  // Strategy: once `useCustomer()` resolves to a customer, wait a short grace
  // window before treating an empty metafield result as authoritative. Guests
  // (no customer) skip the wait - we can't check them anyway, so the original
  // auto-add behavior is preserved.
  const customerPresent = Boolean(customer);
  const customerMetafieldCount = Array.isArray(customerTagMetafields) ? customerTagMetafields.length : 0;
  const [customerMetafieldsObserved, setCustomerMetafieldsObserved] = useState(false);
  useEffect(() => {
    if (!customerPresent) {
      setCustomerMetafieldsObserved(false);
      return;
    }
    if (customerMetafieldCount > 0) {
      setCustomerMetafieldsObserved(true);
      return;
    }
    const t = setTimeout(() => setCustomerMetafieldsObserved(true), 1200);
    return () => clearTimeout(t);
  }, [customerPresent, customerMetafieldCount]);

  // Guest path: look the customer up by typed email against the app backend.
  // useCustomer() only resolves for *authenticated* customers, so a logged-out
  // shopper typing the email of a previously-redeemed account would otherwise
  // skip the check. The backend reads the same `custom.tags` metafield via
  // Admin API and returns a boolean - no PII echoes back.
  let typedEmail: string | undefined;
  try {
    typedEmail = useEmail();
  } catch (_e) {
    typedEmail = undefined;
  }

  const {sessionToken} = useApi();
  const APP_BACKEND_URL = "https://honey-birdette-checkout-amd.onrender.com/api/checkout/redemption-check";

  const [remoteHasRedeemed, setRemoteHasRedeemed] = useState<boolean | null>(null);
  const [remoteCheckedEmail, setRemoteCheckedEmail] = useState<string | null>(null);
  const [remoteCheckInFlight, setRemoteCheckInFlight] = useState(false);

  useEffect(() => {
    // Skip the network call when the local metafield path is already
    // authoritative - saves a round trip per page load for logged-in buyers.
    if (customerPresent && customerMetafieldsObserved) {
      setRemoteHasRedeemed(null);
      setRemoteCheckedEmail(null);
      return;
    }
    if (!config.customer_redeemed_tag) return;

    const email = (typedEmail || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setRemoteHasRedeemed(null);
      setRemoteCheckedEmail(null);
      return;
    }
    if (remoteCheckedEmail === email) return; // already resolved for this email

    let cancelled = false;
    const timer = setTimeout(async () => {
      setRemoteCheckInFlight(true);
      try {
        const token = await sessionToken.get();
        const res = await fetch(APP_BACKEND_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            email,
            redeemed_tag: config.customer_redeemed_tag,
          }),
        });
        if (cancelled) return;
        const data = await res.json().catch(() => ({}));
        setRemoteHasRedeemed(Boolean(data?.redeemed));
        setRemoteCheckedEmail(email);
      } catch (_err) {
        if (cancelled) return;
        // Fail open: assume not redeemed if the backend is unreachable. The
        // merchant's post-order Flow is the safety net for the rare miss.
        setRemoteHasRedeemed(false);
        setRemoteCheckedEmail(email);
      } finally {
        if (!cancelled) setRemoteCheckInFlight(false);
      }
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typedEmail, customerPresent, customerMetafieldsObserved, config.customer_redeemed_tag, sessionToken, remoteCheckedEmail]);

  const effectiveHasRedeemed = hasRedeemed || remoteHasRedeemed === true;

  // Max-total-uses sold-out gate. The storefront API can't read a discount's
  // usage count, so we ask the app backend (which reads asyncUsageCount via the
  // Admin API and deactivates the discount once the cap is hit). We identify the
  // offer by the config's row id, stamped into the shop metafield by the app.
  const GWP_USAGE_URL =
    "https://honey-birdette-checkout-amd.onrender.com/api/checkout/gwp-usage-check";
  const [usageSoldOut, setUsageSoldOut] = useState(false);
  // Whether the usage check has resolved. Uncapped offers are "checked" from the
  // start; capped offers gate the auto-add until we know the sold-out state, so
  // we never add a gift line while its discount is (or is about to be) off - that
  // would add the gift at full price.
  const usageCapConfigured = config.max_total_uses > 0 && Boolean(config.config_id);
  const [usageChecked, setUsageChecked] = useState(false);
  useEffect(() => {
    // Only relevant when this offer has a cap and we know which config to ask
    // about. Uncapped offers never call the backend.
    if (!usageCapConfigured) {
      setUsageSoldOut(false);
      setUsageChecked(true);
      return;
    }
    let cancelled = false;
    setUsageChecked(false);
    (async () => {
      try {
        const token = await sessionToken.get();
        const res = await fetch(GWP_USAGE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ config_id: config.config_id }),
        });
        if (cancelled) return;
        const data = await res.json().catch(() => ({}));
        setUsageSoldOut(Boolean(data?.soldOut));
      } catch (_err) {
        // Fail open: if the backend is unreachable, don't hide a valid gift.
        // The app's sync-time enforcement is the backstop.
        if (!cancelled) setUsageSoldOut(false);
      } finally {
        if (!cancelled) setUsageChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [usageCapConfigured, config.config_id, sessionToken]);

  const redemptionGuardSettled = useMemo(() => {
    if (!config.customer_redeemed_tag) return true; // merchant didn't configure check
    if (customerPresent) return customerMetafieldsObserved; // logged-in: wait for metafield
    // Guest path: settle once we've either resolved a remote check for the
    // typed email, or no email has been typed yet (nothing to gate on).
    const email = (typedEmail || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return true;
    if (remoteCheckInFlight) return false;
    return remoteCheckedEmail === email;
  }, [config.customer_redeemed_tag, customerPresent, customerMetafieldsObserved, typedEmail, remoteCheckInFlight, remoteCheckedEmail]);

  // Debug: show customer tags detected and readable redeemed tag
  const customerTagsDebug = useMemo(() => {
    if (!Array.isArray(customerTagMetafields)) return "";
    const tags = customerTagMetafields.flatMap((m: any) =>
      normalizeTagList(m?.metafield?.value ?? m?.value)
    );
    return tags.join(", ");
  }, [customerTagMetafields]);

  const redeemedTagDebug = (config.customer_redeemed_tag || "").trim();

  useEffect(() => {
    console.log("App metafields:", appMetafields);
    if (customerErrorMessage) {
      console.log("useCustomer error:", customerErrorMessage);
    }
    console.log("Customer:", customer ?? "none");
  }, [appMetafields, customer, customerErrorMessage]);

  useEffect(() => {
    if (!Array.isArray(customerTagMetafields)) {
      console.log("Customer tags: none");
      return;
    }
    const tags = customerTagMetafields.flatMap((m: any) =>
      normalizeTagList(m?.metafield?.value ?? m?.value)
    );
    console.log("Customer tags:", tags.length ? tags : "none");
  }, [customerTagMetafields]);

  // Check: shipping country eligible?
  const shippingOk = useMemo(() => {
    // Explicit "all" -> everyone qualifies.
    if (allowedCountries.all) return true;
    // No restrictions at all -> treat as allowed.
    if (allowedIso2.length === 0 && allowedCountryNames.length === 0 && !allowedCountries.wantsEU) return true;
    const code = (shippingAddress?.current?.countryCode || shippingAddress?.countryCode || "").toUpperCase();
    if (code && allowedIso2.includes(code)) return true;
    // If we didn't have a mapping, also try matching names case-insensitively.
    const name = (shippingAddress?.current?.country || shippingAddress?.country || "").toLowerCase();
    if (name && allowedCountryNames.map((n) => n.toLowerCase()).includes(name)) return true;
    // "EU" qualifies when the shopper is on the EU market.
    if (allowedCountries.wantsEU && marketIdNumeric === EU_MARKET_ID) return true;
    return false;
  }, [shippingAddress, allowedIso2, allowedCountryNames, allowedCountries.all, allowedCountries.wantsEU, marketIdNumeric]);

  const [banner, setBanner] = useState<null | {status: "success" | "warning" | "critical" | "info"; message: string; code?: "sold_out" | "region" | "redeemed" | "generic"}>(null);

  // Build a quick lookup: variantId -> productTags[]
  const variantProductTags = useMemo(() => {
    const map: Record<string, string[]> = {};
    const nodes = tagData?.nodes || [];
    for (const n of nodes) {
      if (n?.id && n?.product?.tags) map[n.id] = n.product.tags as string[];
    }
    return map;
  }, [tagData]);

  // Variants whose product is a gift card. These never count toward a
  // min-spend threshold (a shopper shouldn't be able to unlock a free gift by
  // buying a gift card).
  const giftCardVariantIds = useMemo(() => {
    const set = new Set<string>();
    const nodes = tagData?.nodes || [];
    for (const n of nodes) {
      if (n?.id && (n as any)?.product?.isGiftCard) set.add(n.id);
    }
    return set;
  }, [tagData]);

  // Build a quick lookup: variantId -> price in the active currency.
  // tagData is already fetched in the active currency context so this is the
  // only price map we need.
  const variantPriceMap = useMemo(() => {
    const map: Record<string, number> = {};
    const nodes = tagData?.nodes || [];
    for (const n of nodes) {
      if (n?.id && n?.price?.amount != null) {
        const amt = Number(n.price.amount);
        map[n.id] = isFinite(amt) ? amt : 0;
      }
    }
    return map;
  }, [tagData]);

  // Triggers whose gift is gated on a spend threshold.
  const usesMinSpend =
    config.trigger_type === "min_spend" || config.trigger_type === "buy_x_and_min_spend";

  // Which lines count toward the spend threshold. For min_spend the product_tag
  // narrows the spend to tagged lines. For buy_x_and_min_spend the tag identifies
  // the required "buy X" product instead, and the threshold is measured across the
  // whole cart - so the spend calc ignores the tag, as if it were blank.
  const spendTag = useMemo(
    () => (config.trigger_type === "buy_x_and_min_spend" ? "" : config.product_tag),
    [config.trigger_type, config.product_tag],
  );

  // Compute the spend that counts toward the min-spend threshold. When spendTag
  // is set, only lines carrying that tag count. When it's blank the whole cart
  // counts - excluding the gift line itself and any gift cards.
  const taggedSpend = useMemo(() => {
    const tag = spendTag.toLowerCase();
    let total = 0;
    for (const line of lines) {
      const vId = line.merchandise.id;
      if (giftVariantGid && vId === giftVariantGid) continue;
      if (giftCardVariantIds.has(vId)) continue;
      if (tag) {
        const tags: string[] = variantProductTags[vId] || [];
        const hasTag = tags.some((tg) => tg.toLowerCase() === tag);
        if (!hasTag) continue;
      }
      const unit = variantPriceMap[vId] ?? 0;
      const qty = Number(line.quantity || 1);
      total += unit * (isFinite(qty) ? qty : 1);
    }
    return total;
  }, [lines, variantProductTags, variantPriceMap, spendTag, giftCardVariantIds, giftVariantGid]);

  // Calculate cart-level discounts, excluding shipping-only discounts so we don't inflate the GWP goal
  const totalCartDiscounts = useMemo(() => {
    if (!discountAllocations || discountAllocations.length === 0) return 0;

    const isShippingAllocation = (a: any) => {
      const target = String(a?.targetType || a?.targetSelection || a?.target || '').toUpperCase();
      const title = String(a?.title || a?.discountApplication?.title || '').toUpperCase();
      // Heuristics: many free‑shipping promos surface as SHIPPING target; also guard by title text.
      return target.includes('SHIPPING') || title.includes('SHIPPING');
    };

    return discountAllocations.reduce((total: number, allocation: any) => {
      if (isShippingAllocation(allocation)) return total; // ignore shipping discounts
      const discountAmount = Number(allocation?.discountedAmount?.amount || 0);
      return total + (isFinite(discountAmount) ? discountAmount : 0);
    }, 0);
  }, [discountAllocations]);

  // Calculate total line-item discounts (product discounts like "AMD48D")
  const totalLineItemDiscounts = useMemo(() => {
    let totalDiscount = 0;
    
    for (const line of lines) {
      // discountAllocations is directly on the line object, not nested under cost
      if (line.discountAllocations && line.discountAllocations.length > 0) {
        for (const allocation of line.discountAllocations) {
          const amount = allocation.discountedAmount?.amount || 0;
          totalDiscount += Number(amount);
        }
      }
    }
    
    return totalDiscount;
  }, [lines]);

  // Total of ALL discounts (cart-level + line-item) - kept for debug display
  const totalAllDiscounts = useMemo(() => {
    return totalCartDiscounts + totalLineItemDiscounts;
  }, [totalCartDiscounts, totalLineItemDiscounts]);

  // Sum line-item discount allocations only on the lines that count toward the
  // threshold (e.g. a product discount applied directly to a qualifying SKU).
  const taggedLineItemDiscounts = useMemo(() => {
    const tag = spendTag.toLowerCase();
    let total = 0;
    for (const line of lines) {
      const vId = line.merchandise.id;
      if (giftVariantGid && vId === giftVariantGid) continue;
      if (giftCardVariantIds.has(vId)) continue;
      if (tag) {
        const tags: string[] = variantProductTags[vId] || [];
        const hasTag = tags.some((tg) => tg.toLowerCase() === tag);
        if (!hasTag) continue;
      }
      if (line.discountAllocations && line.discountAllocations.length > 0) {
        for (const allocation of line.discountAllocations) {
          const amount = Number(allocation?.discountedAmount?.amount || 0);
          if (isFinite(amount)) total += amount;
        }
      }
    }
    return total;
  }, [lines, variantProductTags, spendTag, giftCardVariantIds, giftVariantGid]);

  // Gross spend across the non-gift cart, used to apportion order-level
  // discounts back onto tagged lines.
  const nonGiftCartGross = useMemo(() => {
    let total = 0;
    for (const line of lines) {
      if (giftVariantGid && line.merchandise.id === giftVariantGid) continue;
      if (giftCardVariantIds.has(line.merchandise.id)) continue;
      const unit = variantPriceMap[line.merchandise.id] ?? 0;
      const qty = Number(line.quantity || 1);
      total += unit * (isFinite(qty) ? qty : 1);
    }
    return total;
  }, [lines, variantPriceMap, giftVariantGid, giftCardVariantIds]);

  // Order-level discounts apply across the whole cart; only the share that
  // proportionally falls on tagged lines should inflate the qualifying goal.
  const taggedOrderDiscountShare = useMemo(() => {
    if (!totalCartDiscounts || nonGiftCartGross <= 0) return 0;
    return (taggedSpend / nonGiftCartGross) * totalCartDiscounts;
  }, [totalCartDiscounts, taggedSpend, nonGiftCartGross]);

  // Total discount the customer effectively absorbed on tagged products.
  const taggedDiscounts = useMemo(() => {
    return taggedLineItemDiscounts + taggedOrderDiscountShare;
  }, [taggedLineItemDiscounts, taggedOrderDiscountShare]);

  const goal = useMemo(() => {
    const key = `min_spend_${activeCurrency}` as const;
    const byCurrency = (config as any)[key];
    const fallback = Number(config.min_spend || 0);
    return Number(byCurrency ?? fallback ?? 0);
  }, [config.min_spend, config.min_spend_AUD, config.min_spend_NZD, config.min_spend_USD, config.min_spend_CAD, config.min_spend_GBP, config.min_spend_EUR, config.min_spend_AED, activeCurrency]);

  // Inflate the goal only by the discount portion that lands on tagged lines.
  // Whole-cart inflation (the previous approach) wrongly removed gifts when
  // an order discount fell mostly on non-tagged products - the function would
  // then still see qualifying tagged spend and block checkout.
  const adjustedGoal = useMemo(() => {
    return goal + taggedDiscounts;
  }, [goal, taggedDiscounts]);

  const progressPercent = useMemo(() => {
    if (!adjustedGoal) return 0;
    const pct = (taggedSpend / adjustedGoal) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }, [taggedSpend, adjustedGoal]);

  const remaining = Math.max(0, adjustedGoal - taggedSpend);

  // Trigger-type qualification: collapses the three modes down to a single
  // `qualifies` boolean so the rest of the component (intercept, sync effect,
  // eligibility flags) doesn't need to branch per mode.
  const hasSubscriptionLine = useMemo(() => {
    return lines.some((l) => {
      if (giftVariantGid && l.merchandise.id === giftVariantGid) return false;
      const line = l as any;
      const m = l.merchandise as any;
      return Boolean(
        m?.sellingPlan?.id ||
        m?.sellingPlan ||
        line?.sellingPlanAllocation?.sellingPlan?.id ||
        line?.sellingPlanAllocation ||
        line?.sellingPlan
      );
    });
  }, [lines, giftVariantGid]);

  // Build a per-line snapshot of selling-plan-related fields so the in-checkout
  // debug panel can show why subscription detection did/didn't trigger.
  const subscriptionDebug = useMemo(() => {
    return lines
      .filter((l) => !(giftVariantGid && l.merchandise.id === giftVariantGid))
      .map((l) => {
        const line = l as any;
        const m = l.merchandise as any;
        const flags = [
          m?.sellingPlan ? `m.sellingPlan(${m?.sellingPlan?.id || "y"})` : null,
          line?.sellingPlanAllocation ? "l.sellingPlanAllocation" : null,
          line?.sellingPlan ? "l.sellingPlan" : null,
        ].filter(Boolean);
        return `${m?.product?.title || m?.title || l.merchandise.id}: ${flags.length ? flags.join(",") : "none"}`;
      })
      .join(" | ");
  }, [lines, giftVariantGid]);

  // Does the cart hold at least one non-gift line carrying `product_tag`? This is
  // the "buy X" half of buy_x_get_y and buy_x_and_min_spend.
  const hasTaggedLine = useMemo(() => {
    const tag = (config.product_tag || "").toLowerCase();
    if (!tag) return false;
    return lines.some((l) => {
      if (giftVariantGid && l.merchandise.id === giftVariantGid) return false;
      const tags = variantProductTags[l.merchandise.id] || [];
      return tags.some((t) => t.toLowerCase() === tag);
    });
  }, [config.product_tag, lines, variantProductTags, giftVariantGid]);

  const hitsSpendGoal = adjustedGoal > 0 && taggedSpend >= adjustedGoal;

  const qualification = useMemo(() => {
    if (config.trigger_type === "subscription") {
      return { qualifies: hasSubscriptionLine };
    }
    if (config.trigger_type === "buy_x_get_y") {
      return { qualifies: hasTaggedLine };
    }
    if (config.trigger_type === "buy_x_and_min_spend") {
      // Both halves must hold. A blank tag can never satisfy the buy-X half, so
      // this fails closed the same way the discount function does.
      return { qualifies: hasTaggedLine && hitsSpendGoal };
    }
    return { qualifies: hitsSpendGoal };
  }, [config.trigger_type, hasTaggedLine, hitsSpendGoal, hasSubscriptionLine]);

  // --- Validity window check: is offer currently active? ---
  const offerActive = useMemo(() => {
    const tz = STORE_TIMEZONE;
    const now = nowPartsInZone(tz);
    const nowKey = toKey(now.y, now.m, now.d, now.hh, now.mm);

    const startKey = buildKeyFrom(config.valid_date_from, config.valid_time_from);
    const endKey   = buildKeyFrom(config.valid_date_till, config.valid_time_till);

    if (startKey != null && nowKey < startKey) return false;
    if (endKey != null && nowKey > endKey) return false;
    return true;
  }, [config.valid_date_from, config.valid_time_from, config.valid_date_till, config.valid_time_till]);

  // Banner titles for various states
  // Titles support the same {{ title }} / {{ free_gift }} / {{ trigger_type }}
  // / {{ remaining }} / {{ allowed }} placeholders as the messages.
  const titleVars = {
    title: giftTitle || "your free gift",
    remaining: formatMoney(remaining, activeCurrency),
    allowed: allowedDisplay,
  };
  const bannerTitleBefore = renderTemplate(config.banner_title_before || "You're close!", titleVars);
  const bannerTitleAfter = renderTemplate(config.banner_title_after || "Gift with purchase", titleVars);
  // Confirmation title once the gift is in the cart. Falls back to the unlocked
  // title so older configs (no "added" copy) keep their previous wording.
  const bannerTitleAdded = renderTemplate(
    config.banner_title_added || config.banner_title_after || "Gift with purchase",
    titleVars,
  );
  const bannerTitleRedeemed = renderTemplate(config.banner_title_redeemed || "Gift with purchase", titleVars);
  const bannerTitleRegion = renderTemplate(config.banner_title_region || "Gift with purchase", titleVars);

  // Whether the gift is fully free (100% off) vs a partial / purchase-with-
  // purchase deal - drives "Add free X" vs "Add X" CTA wording.
  const giftIsFree = Number(config.discount_percentage ?? 100) >= 100;

  // Confirmation copy shown once the gift is in the cart. Prefers the dedicated
  // "added" message, then the unlocked/after copy, then a sensible default.
  const addedSuccessMessage = (title?: string | null) => {
    // Team rule: no copy input = no copy. If the merchant leaves the "added to
    // cart" message blank we show nothing here (no hardcoded default, and no
    // falling back to the "after"/unlocked copy - that cross-field fallback was
    // what leaked old copy into this state).
    if (!config.banner_message_added) return "";
    return renderTemplate(config.banner_message_added, {
      title: title || giftTitle || (giftIsFree ? "your free gift" : "your gift"),
    });
  };

// Build the offer message text using the template if provided
// Team rule: no copy input = no copy. A blank "before" message renders no text
// (previously it fell back to a hardcoded "Spend X more..." default).
const messageText = config.banner_message_before
  ? renderTemplate(config.banner_message_before, {
      remaining: formatMoney(remaining, activeCurrency),
      title: giftTitle || "your free gift",
    })
  : "";
  // Block checkout progress while the customer is eligible for a gift that
  // hasn't yet been auto-added to the cart. The main effect below adds the
  // gift line; this intercept is a safety net for the brief async window and
  // for cases where the add fails so customers can't slip past unredeemed.
  // Once the gift is confirmed in cart (or after a 3s fallback), we disable
  // the intercept so any stuck error message clears and stays cleared.
  const [interceptDisabled, setInterceptDisabled] = useState(false);

  useEffect(() => {
    if (isGiftInCart) {
      setInterceptDisabled(true);
    }
  }, [isGiftInCart]);

  useEffect(() => {
    const timer = setTimeout(() => setInterceptDisabled(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  useBuyerJourneyIntercept(({canBlockProgress}) => {
    // Manual / multi-option gifts are optional: never block checkout for them.
    if (!autoAdd) return {behavior: 'allow'};
    if (interceptDisabled) return {behavior: 'allow'};
    if (!canBlockProgress) return {behavior: 'allow'};
    if (!config.enabled || !offerActive) return {behavior: 'allow'};
    if (tagsLoading) return {behavior: 'allow'};
    if (!redemptionGuardSettled) return {behavior: 'allow'};
    if (effectiveHasRedeemed || !shippingOk || giftAvailable === false) return {behavior: 'allow'};
    // Usage cap reached: the offer is sold out, so never block checkout for it.
    if (usageSoldOut) return {behavior: 'allow'};
    // Gift can't be loaded (draft / unpublished / bad ID): the offer is hidden,
    // so never block checkout waiting for a gift that will never add.
    if (giftUnresolvable) return {behavior: 'allow'};
    if (!qualification.qualifies) return {behavior: 'allow'};
    if (isGiftInCart) return {behavior: 'allow'};

    return {
      behavior: 'block',
      reason: 'Eligible free gift not yet added to cart',
      errors: [
        {
          message: 'Checking for eligible gifts...',
        },
      ],
    };
  });

  // Guard against concurrent add attempts. The main effect re-fires on many
  // deps (taggedSpend, adjustedGoal, giftAvailable, etc.) and `isGiftInCart`
  // doesn't flip to true until Shopify echoes back the new line, so without
  // this ref we can issue two addCartLine calls before the first lands.
  const addInFlight = useRef(false);

  // Attempt to add the gift line, retrying once on a transient error.
  // Transient failures (network blip, race with another cart mutation) are
  // the most common cause of customers being left without their gift and
  // then blocked by the validation function with no path forward.
  async function tryAddGift(
    sourceLabel: string,
    variantGidArg?: string | null,
    titleArg?: string | null,
  ): Promise<{ ok: boolean; message?: string }> {
    const variantGid = variantGidArg ?? giftVariantGid;
    const title = titleArg ?? giftTitle;
    if (!variantGid) return { ok: false, message: "Gift variant not resolved" };
    const payload = {
      type: "addCartLine" as const,
      merchandiseId: variantGid,
      quantity: 1,
      attributes: [
        { key: "_promo", value: "true" },
        { key: "_type", value: renderTemplate(config.admin_title || "", { title: title || "" }) },
        { key: "_source", value: sourceLabel },
        // "Promo" is a public attribute, so it surfaces in the cart/mini-cart as
        // "Promo: <text>". Only attach it when there's actually copy to show -
        // otherwise the storefront renders an empty "Promo:" label.
        ...(config.cart_message ? [{ key: "Promo", value: config.cart_message }] : []),
      ],
    };
    let lastMessage: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await applyCartLinesChange(payload);
        if ((result as any)?.type === "error") {
          lastMessage = (result as any)?.message ?? "Failed to add gift";
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
        } else {
          return { ok: true };
        }
      } catch (err) {
        lastMessage = err instanceof Error ? err.message : String(err);
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
      }
    }
    return { ok: false, message: lastMessage };
  }

  // Manual add: shown as a fallback button when the auto-add appears stuck
  // or has errored.
  const [manualAdding, setManualAdding] = useState(false);
  async function addGiftManually() {
    if (!giftVariantGid || manualAdding || addInFlight.current) return;
    setManualAdding(true);
    addInFlight.current = true;
    try {
      const result = await tryAddGift("Checkout Gift With Purchase (manual)");
      if (!result.ok) {
        setBanner({ status: "critical", message: result.message ?? "Failed to add gift" });
      } else {
        setBanner({ status: "success", message: addedSuccessMessage() } as any);
      }
    } finally {
      addInFlight.current = false;
      setManualAdding(false);
    }
  }

  // Manual / multi pick: the customer chose a specific gift option. Records the
  // selection, removes any other option already in the cart (a swap), then adds
  // the chosen one. Used both for single manual-add and "pick one of N" offers.
  async function selectGiftOption(productId: string) {
    const opt = resolvedOptions.find((o) => o.productId === productId);
    if (!opt || !opt.variantGid) return;
    if (manualAdding || addInFlight.current) return;
    setSelectedProductId(productId);
    setManualAdding(true);
    addInFlight.current = true;
    try {
      // Remove any previously-picked option (swap to the new choice).
      for (const l of lines) {
        if (optionVariantGids.has(l.merchandise.id) && l.merchandise.id !== opt.variantGid) {
          const removed = await applyCartLinesChange({
            type: "updateCartLine",
            id: l.id,
            quantity: 0,
          });
          if ((removed as any)?.type === "error") {
            setBanner({
              status: "critical",
              message: (removed as any)?.message ?? "Failed to update gift",
            });
            return;
          }
        }
      }
      // Already in cart after the swap pass? Nothing more to do.
      if (lines.some((l) => l.merchandise.id === opt.variantGid)) {
        const successMsg = addedSuccessMessage(opt.title);
        setBanner({ status: "success", message: successMsg } as any);
        return;
      }
      const result = await tryAddGift(
        "Checkout Gift With Purchase (pick)",
        opt.variantGid,
        opt.title,
      );
      if (!result.ok) {
        setBanner({ status: "critical", message: result.message ?? "Failed to add gift" });
      } else {
        const successMsg = addedSuccessMessage(opt.title);
        setBanner({ status: "success", message: successMsg } as any);
      }
    } finally {
      addInFlight.current = false;
      setManualAdding(false);
    }
  }

  // Eligibility splits into "definitely yes" (UI computed it cleanly) and
  // "possibly yes" (UI cannot evaluate because tag data is unavailable).
  // The latter matters because the validation function can still block the
  // customer based on cart contents we don't have a reliable view of - e.g.
  // when an upsell-injected line's tags didn't make it into our last fetch.
  const giftDisallowed = Boolean(
    !offerActive ||
    effectiveHasRedeemed ||
    !shippingOk ||
    giftAvailable === false ||
    usageSoldOut
  );

  const definitelyEligible = Boolean(
    !giftDisallowed &&
    redemptionGuardSettled &&
    qualification.qualifies
  );

  // Tag fetch hard-failed: we can't compute taggedSpend, so we can't rule
  // the customer in or out. Treat as possibly-eligible so the manual button
  // can rescue them if the function is blocking checkout.
  const possiblyEligibleViaTagError = Boolean(
    !giftDisallowed &&
    tagsError != null &&
    !tagsLoading
  );

  const couldBeEligible = definitelyEligible || possiblyEligibleViaTagError;

  // Flip to true ~4s after eligibility is established without the gift
  // landing in cart, so the manual button surfaces even when the auto-add
  // failed silently (e.g., variant unresolved, errored addCartLine never
  // retried, or tag fetch failed and we never even attempted to add).
  const [stuckEligible, setStuckEligible] = useState(false);
  useEffect(() => {
    if (!couldBeEligible || isGiftInCart || !giftVariantGid) {
      setStuckEligible(false);
      return;
    }
    const timer = setTimeout(() => setStuckEligible(true), 4000);
    return () => clearTimeout(timer);
  }, [couldBeEligible, isGiftInCart, giftVariantGid]);

  const hasAddError = Boolean(
    banner?.status === 'critical' &&
    banner.code !== 'redeemed' &&
    banner.code !== 'sold_out' &&
    banner.code !== 'region'
  );

  // Show the manual fallback button (auto mode only) whenever the customer could
  // be eligible, the gift isn't in cart, the variant resolved, and either the
  // auto-add has been stuck for several seconds or an add error has surfaced.
  // Manual / multi offers have their own deliberate chooser UI instead.
  const showManualAddButton = Boolean(
    autoAdd &&
    couldBeEligible &&
    !isGiftInCart &&
    giftVariantGid &&
    (stuckEligible || hasAddError)
  );

  // Main effect: enforce gift presence/removal based on rules
  useEffect(() => {
    if (tagsLoading) return;
    // Defer auto-add until we know whether the customer is redeemed. If a
    // logged-in customer has the redeemed tag, the metafield arrives a beat
    // after first render - adding then removing in that gap caused the bug
    // the merchant reported.
    if (!redemptionGuardSettled) return;
    // Defer auto-add for a capped offer until the usage check resolves, so we
    // never add the gift line while the discount is (or is about to be) off.
    if (usageCapConfigured && !usageChecked) return;
    // If outside the configured validity window, ensure gift is removed
    if (!offerActive) {
      (async () => {
        await removeGiftIfPresent();
      })();
      return;
    }
    // Guard: in auto mode, if the customer qualifies and the gift isn't in cart
    // yet but the variant hasn't resolved, wait. (In manual/multi mode an
    // unresolved/unselected gift is normal - the chooser UI handles it.)
    if (autoAdd && qualification.qualifies && !isGiftInCart && !giftVariantGid) {
      // Soft info message avoids misleading critical banner titles
      setBanner({ status: "info", message: "Preparing your gift…" } as any);
      return;
    }

    async function syncGift() {
      // 1) If customer has redeemed -> ensure gift removed and show message
      if (effectiveHasRedeemed) {
        await removeGiftIfPresent();
        const redeemedMsg = config.banner_message_redeemed
          ? renderTemplate(config.banner_message_redeemed, { title: giftTitle || "your free gift" })
          : "Sorry, you've already redeemed.";
        setBanner({ status: "critical", message: redeemedMsg, code: "redeemed" } as any);
        return;
      }

      // 2) If shipping country not allowed -> ensure gift removed and show message
      if (!shippingOk) {
        await removeGiftIfPresent();
        const allowedList = allowedDisplay || allowedCountryNames.join(", ") || allowedIso2.join(", ");
        const regionMsg = config.banner_message_region
          ? renderTemplate(config.banner_message_region, { allowed: allowedList, title: giftTitle || "your free gift" })
          : `Sorry, we are only shipping this gift to ${allowedList}.`;
        setBanner({ status: "warning", message: regionMsg, code: "region" } as any);
        return;
      }

      // 2b) If the gift product is sold out -> ensure gift removed and show message
      if (giftAvailable === false) {
        await removeGiftIfPresent();
        const soldMsg = config.sold_out_message || "Sorry, sold out.";
        setBanner({ status: "warning", message: soldMsg, code: "sold_out" } as any);
        return;
      }

      // 2c) If the discount's usage cap is reached -> treat as sold out. The app
      // has (or will) deactivate the discount, so the gift would no longer be
      // free; remove any promo gift line and show the sold-out message.
      if (usageSoldOut) {
        await removeGiftIfPresent();
        const soldMsg = config.sold_out_message || "Sorry, sold out.";
        setBanner({ status: "warning", message: soldMsg, code: "sold_out" } as any);
        return;
      }

      // 3) If trigger qualifies, ensure gift is added; otherwise, remove it
      if (qualification.qualifies) {
        // If a gift is already in cart (e.g., after reload), show success.
        if (anyGiftOptionInCart) {
          setBanner({ status: "success", message: addedSuccessMessage() } as any);
          return;
        }
        // Manual / multi-option: don't auto-add. Clear any stale banner and let
        // the chooser UI prompt the customer to add or pick a gift.
        if (!autoAdd) {
          setBanner(null);
          return;
        }
        // Auto mode (single gift): add it for the customer.
        if (!giftVariantGid) {
          setBanner({ status: "critical", message: "Gift variant is not resolved yet. Please try again." });
          return;
        }
        if (addInFlight.current) return;
        addInFlight.current = true;
        try {
          const result = await tryAddGift("Checkout Gift With Purchase");
          if (!result.ok) {
            setBanner({ status: "critical", message: result.message ?? "Failed to add gift" });
          } else {
            setBanner({ status: "success", message: addedSuccessMessage() } as any);
          }
        } finally {
          addInFlight.current = false;
        }
      } else {
        await removeGiftIfPresent();
        setBanner(null);
      }
    }

    // Fire and forget (sequential inside)
    void syncGift();
  }, [tagsLoading, redemptionGuardSettled, effectiveHasRedeemed, shippingOk, taggedSpend, isGiftInCart, anyGiftOptionInCart, autoAdd, giftVariantGid, giftAvailable, adjustedGoal, offerActive, qualification.qualifies, usageSoldOut, usageCapConfigured, usageChecked]);

  // (Optional) show fetch error
  // {tagsError ? <Text size="small">Tag fetch error</Text> : null}

  // Debug helpers for displaying the validity window and current store time
  const validFromStr = `${config.valid_date_from || '-'} ${config.valid_time_from || ''}`.trim();
  const validTillStr = `${config.valid_date_till || '-'} ${config.valid_time_till || ''}`.trim();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const nowDbg = (() => {
    const np = nowPartsInZone(STORE_TIMEZONE);
    return `${np.y}-${pad2(np.m)}-${pad2(np.d)} ${pad2(np.hh)}:${pad2(np.mm)} ${STORE_TIMEZONE}`;
  })();

  // Hide the component entirely when offer is inactive, unless debug is enabled
  if (!offerActive && !config.show_testing_information) return null;

  // Hide the offer when its gift product can't be loaded (draft, unpublished to
  // this sales channel, or a bad ID). The customer just sees no offer instead
  // of a technical "couldn't resolve variant" error. Sold-out is intentionally
  // NOT hidden here - it has its own merchant-configurable message. Still shown
  // in testing mode so merchants can see the diagnostics and fix the config.
  if (giftUnresolvable && !config.show_testing_information) return null;

  // Decide whether any visible content would render. If not, return null so the
  // component doesn't leave an empty bordered box in checkout.
  const showProgressBanner = Boolean(
    config.show_banners && offerActive && !effectiveHasRedeemed && shippingOk && !usageSoldOut && !qualification.qualifies && !isGiftInCart &&
    (!usesMinSpend || adjustedGoal > 0)
  );
  const showStatusBanner = Boolean(
    offerActive && banner && (banner.status === 'success' ? config.show_success_banner : config.show_banners)
  );

  // Manual / multi offers prompt the customer to add or pick their gift once
  // they qualify. `definitelyEligible` already folds in qualification, region,
  // redemption and validity checks, so this only shows when it should.
  const giftChooserEligible = Boolean(
    !autoAdd && offerActive && definitelyEligible && resolvedOptions.some((o) => o.variantGid)
  );
  // Single manual gift: an optional "add it" button until it's in the cart.
  const showSingleManualAdd = Boolean(
    giftChooserEligible && !isMultiOption && !anyGiftOptionInCart
  );
  // Pick one of N: cards stay visible while qualifying so the customer can also
  // switch their choice after adding one.
  const showMultiChooser = Boolean(giftChooserEligible && isMultiOption);

  if (
    !showProgressBanner &&
    !showStatusBanner &&
    !showManualAddButton &&
    !showSingleManualAdd &&
    !showMultiChooser &&
    !config.show_testing_information
  )
    return null;

  // Small product thumbnail shown alongside the gift copy at every step.
  const giftThumb = (url: string | null | undefined, size = 64) =>
    url ? (
      <View maxInlineSize={size}>
        <Image
          source={url}
          accessibilityDescription={giftTitle || "Free gift"}
          border="base"
          cornerRadius="base"
        />
      </View>
    ) : null;

  // Honey Club-style offer card: a single bordered row with the gift preview
  // (thumbnail + bold title + subdued descriptor) on the left and the action
  // button pinned to the right, vertically centred. Shared across every offer
  // state so the GWP banners read like the loyalty "rewards" cards.
  const OfferCard = ({
    image,
    title,
    subtitle,
    price,
    button,
    imageSize = 64,
    bordered = true,
  }: {
    image?: string | null;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    price?: React.ReactNode;
    button?: React.ReactNode;
    imageSize?: number;
    // When false, render the row without its own border/padding. Used inside the
    // success Banner, which already supplies a bordered container - the extra
    // OfferCard border there reads as a messy double box around the product.
    bordered?: boolean;
  }) => {
    // Lay the row out as columns so the button is pushed flush to the right
    // edge (no empty gap beside it): [thumb?] [content fills] [button?].
    const columns: ("auto" | "fill")[] = [];
    const cells: React.ReactNode[] = [];
    if (image) {
      columns.push("auto");
      cells.push(<View key="thumb">{giftThumb(image, imageSize)}</View>);
    }
    columns.push("fill");
    cells.push(
      <BlockStack key="content" spacing="none">
        {title ? (
          <Heading>{typeof title === "string" ? title.toUpperCase() : title}</Heading>
        ) : null}
        {subtitle ? <Text appearance="subdued">{subtitle}</Text> : null}
        {price || null}
      </BlockStack>,
    );
    if (button) {
      columns.push("auto");
      cells.push(<View key="action">{button}</View>);
    }
    return (
      <View
        {...(bordered ? { border: "base", cornerRadius: "base", padding: "base" } : {})}
      >
        <InlineLayout columns={columns} spacing="base" blockAlignment="center">
          {cells}
        </InlineLayout>
      </View>
    );
  };

  // Discounted gift pricing. The customer pays the configured % off the product
  // price; we show that post-discount price prominently with the full price
  // beside it as the compare-at reference. (Checkout Text has no strikethrough,
  // so the original renders subdued rather than struck through.)
  const giftPrice = (
    opt?: {priceAmount?: number | null; priceCurrency?: string | null} | null,
  ): React.ReactNode => {
    if (!opt || opt.priceAmount == null) return null;
    const currency = opt.priceCurrency || activeCurrency;
    const pct = Math.max(0, Math.min(100, Number(config.discount_percentage ?? 100)));
    const discounted = opt.priceAmount * (1 - pct / 100);
    return (
      <InlineStack spacing="tight" blockAlignment="center">
        <Text emphasis="bold">
          {discounted <= 0 ? "FREE" : formatMoney(discounted, currency)}
        </Text>
        {pct > 0 ? (
          <Text appearance="subdued" accessibilityRole="deletion">
            {formatMoney(opt.priceAmount, currency)}
          </Text>
        ) : null}
      </InlineStack>
    );
  };

  // Render a small debug/status UI
  return (
    <BlockStack {...(config.show_testing_information ? { border: "dotted", padding: "tight" } : {})}>


      {/* Offer progress banner (shows until the gift is unlocked). A label pill
          and a progress bar render for every trigger type. For the spend-gated
          triggers the bar tracks real spend; subscription / buy_x_get_y are
          boolean gates, so the bar reads 0% until the qualifying item is in the
          cart (at which point the gift adds and this banner is replaced by the
          success banner). buy_x_and_min_spend is both: the bar tracks spend, and
          a hint below it calls out the still-missing tagged product. */}
      {showProgressBanner ? (
        <Section title={bannerTitleBefore} subtitle={config.banner_subtitle}>
          {config.label ? <OfferBadge>{config.label}</OfferBadge> : null}
          <BlockStack spacing="tight">
            {config.trigger_type !== "buy_x_get_y" ? (
              <ProgressBar
                percent={usesMinSpend ? progressPercent : (qualification.qualifies ? 100 : 0)}
              />
            ) : null}
            {usesMinSpend && remaining > 0 ? (
              <Text size="small" appearance="subdued">
                Spend {formatMoney(remaining, activeCurrency)} more
              </Text>
            ) : null}
            {config.trigger_type === "buy_x_and_min_spend" && !hasTaggedLine ? (
              <Text size="small" appearance="subdued">
                {config.banner_buy_x_hint || "Add a qualifying product to unlock this offer"}
              </Text>
            ) : null}
          </BlockStack>
          <OfferCard
            image={resolvedOptions[0]?.image}
            title={resolvedOptions[0]?.title || giftTitle || "Your free gift"}
            subtitle={messageText || (giftIsFree ? "Free item included" : undefined)}
            price={giftPrice(resolvedOptions[0])}
            button={
              config.button_url ? (
                <Button to={String(config.button_url)} kind="primary" target="new">
                  {config.button_text || "Go to collection"}
                </Button>
              ) : undefined
            }
          />
        </Section>
      ) : null}

      {/* Existing status banner from logic (success / warning / critical).
          Success uses its own toggle so it can show even when other banners are hidden. */}
      {showStatusBanner && banner ? (
        <Banner
          status={banner.status}
          title={
            banner.code === 'sold_out' ? renderTemplate(config.banner_title_sold_out || 'Sold out', titleVars) :
            banner.status === 'success' ? bannerTitleAdded :
            banner.status === 'warning' ? bannerTitleRegion :
            banner.status === 'info' ? bannerTitleBefore :
            // Only the genuine "already redeemed" critical state borrows the
            // redeemed headline. Other critical errors (e.g. variant could not
            // be resolved, generic add failures) carried no code and wrongly
            // showed "You've already claimed this offer"; give them a neutral
            // title instead.
            banner.code === 'redeemed' ? bannerTitleRedeemed :
            bannerTitleAfter
          }
        >
          {banner.status === 'success' && selectedOption?.image ? (
            <OfferCard
              bordered={false}
              image={selectedOption.image}
              title={selectedOption.title || giftTitle || "Your free gift"}
              subtitle={banner.message || (giftIsFree ? "Free item included" : undefined)}
              price={giftPrice(selectedOption)}
            />
          ) : (
            banner.message || null
          )}
        </Banner>
      ) : null}

      {/* Manual fallback: when the customer qualifies but the gift hasn't
          auto-added (errored, or stuck for several seconds), give them a
          button to add it themselves so they can still complete checkout. */}
      {showManualAddButton ? (
        <Banner status="warning" title="Add your free gift">
          <OfferCard
            image={selectedOption?.image}
            title={giftTitle || "Your free gift"}
            subtitle={`We couldn't add your free ${giftTitle || "gift"} automatically. Tap the button to add it now.`}
            price={giftPrice(selectedOption)}
            button={
              <Button kind="primary" onPress={addGiftManually} loading={manualAdding}>
                {(manualAdding ? "Adding…" : "Add").toUpperCase()}
              </Button>
            }
          />
        </Banner>
      ) : null}

      {/* Single manual gift: an optional button to add the earned gift. The
          customer can ignore it and still check out (manual = optional). */}
      {showSingleManualAdd ? (
        <Section title={bannerTitleAfter || "Your free gift"} subtitle={config.banner_subtitle}>
          {/* Honey Club-style layout: gift preview + descriptor on the left, a
              short action button on the right, instead of a full-width CTA. */}
          {config.label ? <OfferBadge>{config.label}</OfferBadge> : null}
          <OfferCard
            image={selectedOption?.image}
            title={selectedOption?.title || giftTitle || "Your free gift"}
            subtitle={
              config.banner_message_after
                ? renderTemplate(config.banner_message_after, {
                    title: selectedOption?.title || (giftIsFree ? "your free gift" : "your gift"),
                    remaining: formatMoney(remaining, activeCurrency),
                  })
                : giftIsFree
                  ? "Free item included"
                  : undefined
            }
            price={giftPrice(selectedOption)}
            button={
              <Button
                kind="primary"
                loading={manualAdding}
                disabled={giftAvailable === false}
                onPress={() => effectiveSelectedId && selectGiftOption(effectiveSelectedId)}
              >
                {(manualAdding ? "Adding…" : "Add").toUpperCase()}
              </Button>
            }
          />
        </Section>
      ) : null}

      {/* Pick one of N: product cards, one Select per option. Selecting swaps
          the cart line. Cards stay visible after a pick so the customer can
          change their mind. */}
      {showMultiChooser ? (
        <Section title={anyGiftOptionInCart ? bannerTitleAdded : "Choose your free gift"} subtitle={config.banner_subtitle}>
          {config.label ? <OfferBadge>{config.label}</OfferBadge> : null}
          <Text>
            {anyGiftOptionInCart
              ? "Tap another option to switch your free gift."
              : "You've earned a free gift. Choose one:"}
          </Text>
          {resolvedOptions.map((opt) => {
              if (!opt.variantGid) return null;
              const inCart = lines.some((l) => l.merchandise.id === opt.variantGid);
              const isSelected = effectiveSelectedId === opt.productId && inCart;
              const soldOut = opt.available === false;
              const pending = manualAdding && selectedProductId === opt.productId;
              return (
                <OfferCard
                  key={opt.productId}
                  image={opt.image}
                  title={opt.title || "Gift"}
                  subtitle={
                    soldOut ? (
                      <Text appearance="critical">Sold out</Text>
                    ) : giftIsFree ? (
                      "Free item included"
                    ) : undefined
                  }
                  price={soldOut ? undefined : giftPrice(opt)}
                  button={
                    <Button
                      kind={isSelected ? "secondary" : "primary"}
                      disabled={soldOut || isSelected}
                      loading={pending}
                      onPress={() => selectGiftOption(opt.productId)}
                    >
                      {(isSelected
                        ? "Selected"
                        : anyGiftOptionInCart
                          ? "Choose this instead"
                          : "Select"
                      ).toUpperCase()}
                    </Button>
                  }
                />
              );
            })}
        </Section>
      ) : null}

    {config.show_testing_information ? (
      <>
        {/* Optional: tiny diagnostics */}
        <Text size="small">Trigger type: {config.trigger_type} | Qualifies: {qualification.qualifies ? "yes" : "no"}</Text>
        <Text size="small">
          Gift option IDs (config): {optionIds.length ? optionIds.join(", ") : "-"}
        </Text>
        <Text size="small">
          Gift resolve: {resolvedOptions.length === 0
            ? "(resolving…)"
            : resolvedOptions
                .map((o) => `${o.productId} -> ${o.variantGid ? `${o.variantGid}${o.available === false ? " (sold out)" : ""}` : "UNRESOLVED"}`)
                .join(" | ")}
        </Text>
        {config.trigger_type === "subscription" ? (
          <Text size="small">Subscription line scan: {subscriptionDebug || "(no non-gift lines)"}</Text>
        ) : null}
        <Text size="small">Config tag: {config.product_tag || "-"} | Min spend: {formatMoney(Number(goal || 0), activeCurrency)} ({activeCurrency})</Text>
        <Text size="small">Cart-level discounts (order, excl. shipping): {formatMoney(totalCartDiscounts, activeCurrency)}</Text>
        <Text size="small">Line-item discounts (product): {formatMoney(totalLineItemDiscounts, activeCurrency)}</Text>
        <Text size="small">Total ALL discounts: {formatMoney(totalAllDiscounts, activeCurrency)}</Text>
        <Text size="small">Tagged-line item discounts: {formatMoney(taggedLineItemDiscounts, activeCurrency)}</Text>
        <Text size="small">Tagged share of order discounts: {formatMoney(taggedOrderDiscountShare, activeCurrency)}</Text>
        <Text size="small">Tagged discounts (used for goal): {formatMoney(taggedDiscounts, activeCurrency)}</Text>
        <Text size="small">Adjusted goal (min spend + tagged discounts): {formatMoney(adjustedGoal, activeCurrency)}</Text>
        <Text size="small">Market handle: {market?.handle || "-"} | Checkout currency: {apiLocalization?.currency?.isoCode || "-"}</Text>
        <Text size="small">Market ID: {String(market?.id || "-")} | Active currency: {activeCurrency} (detected: {detectedCurrencyIso || "-"})</Text>
        <Text size="small">Tagged spend detected: {taggedSpend.toFixed(2)}</Text>
        <Text size="small">Customer tags detected: {customerTagsDebug || "-"}</Text>
        <Text size="small">Redeemed tag ("{redeemedTagDebug}") present: {hasRedeemed ? "yes" : "no"}</Text>
        <Text size="small">Customer present: {customerPresent ? "yes" : "no"} | Metafields observed: {customerMetafieldsObserved ? "yes" : "no"} | Guard settled: {redemptionGuardSettled ? "yes" : "no"}</Text>
        <Text size="small">Typed email: {typedEmail || "-"} | Remote check: {remoteCheckInFlight ? "in-flight" : (remoteCheckedEmail || "not run")} | Remote redeemed: {remoteHasRedeemed === null ? "-" : (remoteHasRedeemed ? "yes" : "no")} | Effective redeemed: {effectiveHasRedeemed ? "yes" : "no"}</Text>
        {customerErrorMessage ? (
          <Text size="small">useCustomer error: {customerErrorMessage}</Text>
        ) : null}
        <Text size="small">Offer window: from {validFromStr || '-'} to {validTillStr || '-'}</Text>
        <Text size="small">Store time now: {nowDbg}</Text>
        <Text size="small">Offer active: {offerActive ? 'yes' : 'no'}</Text>
      </>
    ) : null}
    </BlockStack>
  );
}
