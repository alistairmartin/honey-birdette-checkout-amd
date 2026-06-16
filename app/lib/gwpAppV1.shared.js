// Pure constants + helpers shared between the Gift With Purchase admin route
// (client bundle) and its server module. Kept out of `*.server.js` so Remix can
// include them client-side without tripping the "server-only module" guard.
//
// Two consumers read configs that originate here:
//   - the `gift-with-purchase` checkout extension reads the full config array
//     from a SHOP metafield ($app:gift-with-purchase / configs).
//   - the `gift-with-purchase-discount` Shopify Function reads a slimmed-down
//     array (built by buildFunctionConfigs) from the discount node metafield
//     ($app / function-configuration) and applies the price reduction.

export const SUPPORTED_CURRENCIES = [
  "AUD",
  "NZD",
  "USD",
  "CAD",
  "GBP",
  "EUR",
  "AED",
];

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

// Sensible starting thresholds for the builder's min-spend fields.
export const DEFAULT_THRESHOLDS = {
  AUD: 250,
  NZD: 270,
  USD: 160,
  CAD: 220,
  GBP: 130,
  EUR: 150,
  AED: 590,
};

// Free gift by default. PWP offers set this lower (e.g. 50 for 50% off).
export const DEFAULT_DISCOUNT_PERCENTAGE = 100;

// Metafield wiring.
export const SHOP_METAFIELD_NAMESPACE = "$app:gift-with-purchase";
export const SHOP_METAFIELD_KEY = "configs";
export const FUNCTION_METAFIELD_NAMESPACE = "$app";
export const FUNCTION_METAFIELD_KEY = "function-configuration";

// Accepts a numeric id or a Product gid; returns a Product gid (or null).
export function toProductGid(value) {
  if (value == null || value === "") return null;
  const str = String(value).trim();
  if (str.startsWith("gid://shopify/Product/")) return str;
  if (str.startsWith("gid://shopify/ProductVariant/")) return null; // variant, not a product
  const numeric = str.replace(/[^0-9]/g, "");
  return numeric ? `gid://shopify/Product/${numeric}` : null;
}

// Returns a ProductVariant gid only when the input already is one.
export function toVariantGid(value) {
  if (value == null || value === "") return null;
  const str = String(value).trim();
  return str.startsWith("gid://shopify/ProductVariant/") ? str : null;
}

// Build the per-currency thresholds map from a raw config's min_spend_* fields.
// Only currencies with a positive number are included; the function treats a
// missing currency as "this offer doesn't run in that market".
export function thresholdsFromConfig(config) {
  const out = {};
  for (const code of SUPPORTED_CURRENCIES) {
    const raw = Number(config[`min_spend_${code}`]);
    if (Number.isFinite(raw) && raw > 0) out[code] = raw;
  }
  return out;
}

// Map raw saved configs (the same objects the checkout extension reads) into the
// slim shape the discount function needs. The function only cares about whether
// to discount the gift line and by how much, so it gets the gift product/variant,
// a per-currency threshold map (for min_spend), the trigger type, and the
// percentage. Eligibility beyond the subtotal gate is enforced by the extension,
// which only adds the gift line when the offer actually qualifies.
export function buildFunctionConfigs(rawConfigs) {
  return (Array.isArray(rawConfigs) ? rawConfigs : [])
    .filter((c) => c && typeof c === "object" && c.enabled !== false)
    .map((c) => {
      const productId = toProductGid(c.product_id);
      const variantGid = toVariantGid(c.product_id);
      const pct = Number(c.discount_percentage);
      return {
        enabled: true,
        trigger_type: String(c.trigger_type || "min_spend"),
        discount_percentage:
          Number.isFinite(pct) && pct > 0 && pct <= 100
            ? pct
            : DEFAULT_DISCOUNT_PERCENTAGE,
        thresholds: thresholdsFromConfig(c),
        productId: productId || null,
        variantIds: variantGid ? [variantGid] : [],
        message: String(c.label || c.admin_title || "Gift with purchase"),
      };
    })
    .filter((c) => c.productId || c.variantIds.length > 0);
}
