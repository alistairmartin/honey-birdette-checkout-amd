// Pure constants + helpers shared between the Checkout Recommendations admin
// route (client bundle) and its server module. Kept out of `*.server.js` so
// Remix can include them client-side without tripping the "server-only module"
// guard.
//
// The `checkout-recommendations` checkout extension reads the single config
// object written here from a SHOP metafield ($app:checkout-recommendations /
// config) via the storefront API. Base recommendations still come from the
// `mini_cart_recommendations` metaobjects; the config below layers extra rules
// (free-shipping gap-fill) and the migrated block settings on top.

export const SUPPORTED_CURRENCIES = ["AUD", "NZD", "USD", "CAD", "GBP", "EUR", "AED"];

// Per-currency @inContext country used by the checkout extension to price cart
// lines. Kept here so the admin UI and extension agree on the supported set.
export const COUNTRY_BY_CURRENCY = {
  AUD: "AU",
  NZD: "NZ",
  USD: "US",
  CAD: "CA",
  GBP: "GB",
  EUR: "DE",
  AED: "AE",
};

// Metafield wiring. PUBLIC_READ storefront access lets the checkout extension
// read it via `shopify.query`.
export const SHOP_METAFIELD_NAMESPACE = "$app:checkout-recommendations";
export const SHOP_METAFIELD_KEY = "config";

// The metaobject type the extension resolves base recommendations from. Surfaced
// here only so the admin page can show it (the extension keeps its own default).
export const BASE_METAOBJECT_TYPE = "mini_cart_recommendations";

export const DEFAULT_HEADING = "You May Also Like";
export const DEFAULT_MAX_PRODUCTS = 6;

// Number of manual upsell slots offered in the admin (matches the extension's
// historical manual_product1..4 settings).
export const MANUAL_UPSELL_SLOTS = 4;

// Accepts a numeric id or a ProductVariant gid; returns a ProductVariant gid (or
// null). Manual upsells and gap-fill products are stored as variant gids so the
// extension can price and add the exact variant.
export function toVariantGid(value) {
  if (value == null || value === "") return null;
  const str = String(value).trim();
  if (str.startsWith("gid://shopify/ProductVariant/")) return str;
  if (str.startsWith("gid://")) return null; // some other gid
  const numeric = str.replace(/[^0-9]/g, "");
  return numeric ? `gid://shopify/ProductVariant/${numeric}` : null;
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Produce the canonical config object the extension consumes from whatever the
// admin builder (or a previously-stored metafield) hands us. Drops empty values
// so the published JSON stays small and the extension can trust the shape.
export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};

  const heading = String(src.heading ?? "").trim() || DEFAULT_HEADING;
  const maxProducts = toFiniteOrNull(src.max_products) ?? DEFAULT_MAX_PRODUCTS;

  const manualUpsells = (Array.isArray(src.manual_upsells) ? src.manual_upsells : [])
    .map(toVariantGid)
    .filter(Boolean)
    .slice(0, MANUAL_UPSELL_SLOTS);

  // free_shipping: { AUD: { standard, express }, ... } - only positive numbers kept.
  const freeShipping = {};
  const rawFs = src.free_shipping && typeof src.free_shipping === "object" ? src.free_shipping : {};
  for (const code of SUPPORTED_CURRENCIES) {
    const entry = rawFs[code] && typeof rawFs[code] === "object" ? rawFs[code] : {};
    const standard = toFiniteOrNull(entry.standard);
    const express = toFiniteOrNull(entry.express);
    if (standard || express) {
      freeShipping[code] = {};
      if (standard) freeShipping[code].standard = standard;
      if (express) freeShipping[code].express = express;
    }
  }

  // gap_fill: { enabled, within: { AUD: n }, products: { AUD: [variantGid] } }.
  const rawGap = src.gap_fill && typeof src.gap_fill === "object" ? src.gap_fill : {};
  const gapWithin = {};
  const gapProducts = {};
  const rawWithin = rawGap.within && typeof rawGap.within === "object" ? rawGap.within : {};
  const rawProducts = rawGap.products && typeof rawGap.products === "object" ? rawGap.products : {};
  for (const code of SUPPORTED_CURRENCIES) {
    const within = toFiniteOrNull(rawWithin[code]);
    if (within) gapWithin[code] = within;
    const products = (Array.isArray(rawProducts[code]) ? rawProducts[code] : [])
      .map(toVariantGid)
      .filter(Boolean);
    if (products.length) gapProducts[code] = products;
  }

  return {
    heading,
    max_products: maxProducts,
    manual_upsells: manualUpsells,
    free_shipping: freeShipping,
    gap_fill: {
      enabled: rawGap.enabled !== false,
      within: gapWithin,
      products: gapProducts,
    },
  };
}

// The empty starting config for the admin builder.
export function emptyConfig() {
  return {
    heading: DEFAULT_HEADING,
    max_products: DEFAULT_MAX_PRODUCTS,
    manual_upsells: [],
    free_shipping: {},
    gap_fill: { enabled: true, within: {}, products: {} },
  };
}
