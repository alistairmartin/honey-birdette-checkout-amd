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

// The rules that can unlock a gift.
//   min_spend           - spend N on products carrying `product_tag` (whole cart
//                         when the tag is blank).
//   subscription        - any cart line with a selling plan.
//   buy_x_get_y         - at least one cart line carrying `product_tag`.
//   buy_x_and_min_spend - BOTH: one line carrying `product_tag`, AND N spent
//                         across the whole cart (the tag does not narrow the
//                         spend here, unlike min_spend). Gift cards never count.
export const TRIGGER_TYPES = [
  { label: "Min spend", value: "min_spend" },
  { label: "Subscription", value: "subscription" },
  { label: "Buy X get Y", value: "buy_x_get_y" },
  { label: "Buy X + min spend", value: "buy_x_and_min_spend" },
];

// Triggers whose gift is gated on a per-currency spend threshold.
export function triggerUsesMinSpend(triggerType) {
  const t = String(triggerType || "min_spend");
  return t === "min_spend" || t === "buy_x_and_min_spend";
}

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
    .map((c) => buildFunctionConfig(c))
    .filter(Boolean);
}

// Collect every gift product/variant a config can hand out: the primary
// `product_id` plus any `gift_options[]` (the customer-picks-one set). Returns
// de-duplicated arrays of Product gids and ProductVariant gids. Only one option
// is ever in the cart at a time (the checkout extension adds the chosen one), so
// the discount function can safely target the whole set.
function collectGiftTargets(c) {
  const rawIds = [];
  if (c.product_id != null && c.product_id !== "") rawIds.push(c.product_id);
  if (Array.isArray(c.gift_options)) {
    for (const opt of c.gift_options) {
      const pid = opt && typeof opt === "object" ? opt.product_id : opt;
      if (pid != null && pid !== "") rawIds.push(pid);
    }
  }
  const productIds = [];
  const variantIds = [];
  for (const raw of rawIds) {
    const pgid = toProductGid(raw);
    if (pgid && !productIds.includes(pgid)) productIds.push(pgid);
    const vgid = toVariantGid(raw);
    if (vgid && !variantIds.includes(vgid)) variantIds.push(vgid);
  }
  return { productIds, variantIds };
}

// Build the slim function-config object for a single raw config, or null when it
// has no gift product/variant to target. Unlike buildFunctionConfigs this does
// NOT filter on `enabled` - in the per-config discount model the enable/disable
// state is carried by activating/deactivating the config's own discount, not by
// omitting it from the metafield.
//
// `qualifyingProductIds` is the config's `product_tag` already resolved to Product
// gids by the caller (see resolveQualifyingProductIds in gwpAppV1.server.js). Only
// buy_x_and_min_spend uses it: the function can't read product tags, so it needs
// the ids to enforce the "buy X" half of the trigger itself.
export function buildFunctionConfig(c, qualifyingProductIds = []) {
  if (!c || typeof c !== "object") return null;
  const { productIds, variantIds } = collectGiftTargets(c);
  if (productIds.length === 0 && variantIds.length === 0) return null;
  const pct = Number(c.discount_percentage);
  const trigger_type = String(c.trigger_type || "min_spend");
  return {
    enabled: true,
    trigger_type,
    ...(trigger_type === "buy_x_and_min_spend"
      ? {
          qualifying_product_ids: Array.isArray(qualifyingProductIds)
            ? qualifyingProductIds
            : [],
        }
      : {}),
    discount_percentage:
      Number.isFinite(pct) && pct > 0 && pct <= 100
        ? pct
        : DEFAULT_DISCOUNT_PERCENTAGE,
    thresholds: thresholdsFromConfig(c),
    // `productId` kept for backward-compat with older function bundles; `productIds`
    // carries the full set so any chosen gift option gets discounted.
    productId: productIds[0] || null,
    productIds,
    variantIds,
    message: String(c.label || c.admin_title || "Gift with purchase"),
  };
}
