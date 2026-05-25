# Lubricant Bundle Cart Transform - Quick Summary

Paste into a fresh Claude chat to continue work on the cart transform.

## What it does

Visually merges qualifying cart lines into a parent "bundle" line (e.g.
"Platinum Lubricant Kit") with the children indented under it. Bakes a
per-currency discount into the merged line price via `percentageDecrease`.
Attaches an `Original Price` cart line attribute showing the pre-discount sum.

## Files

- `extensions/lubricant-bundle-transform/src/cart_transform_run.graphql` -
  fetches cart lines (id, qty, `cost.amountPerQuantity {amount currencyCode}`,
  variant + product id) and the cart transform's own `$app:bundle-index`
  metafield.
- `extensions/lubricant-bundle-transform/src/cart_transform_run.ts` -
  slot-matches bundles, emits `linesMerge` ops with price + attributes.
- `app/lib/lubricantBundle.server.js` - `installCartTransform`,
  `uninstallCartTransform`, `syncBundleIndexToCartTransform`,
  `inspectBundleIndex`, plus the shared metaobject flatten.
- `app/routes/app.cart-transform.jsx` - admin page at `/app/cart-transform`
  for install / resync / uninstall + diagnostic view of the current index.
- `app/routes/webhooks.jsx` - on `metaobjects/update|delete` calls
  `syncBundleIndexToCartTransform` to keep the index fresh.

## Data flow

Merchant edits `lubricant_bundle` metaobject -> `metaobjects/update` webhook
fires -> handler calls `syncBundleIndexToCartTransform(admin)` -> writes
flattened JSON to the CartTransform's `$app:bundle-index` metafield ->
function reads it at runtime.

The function never queries the merchant metaobject directly (Shopify functions
can only read app-owned `$app:` metaobjects).

## Bundle index JSON shape

```json
{
  "bundles": [{
    "id": "gid://shopify/Metaobject/...",
    "name": "Platinum Lubricant Kit",
    "parentVariantId": "gid://shopify/ProductVariant/...",
    "productIds": ["gid://.../Product/..."],
    "option1Ids": ["..."],
    "option2Ids": ["..."],
    "discountAmounts": {"AUD": 20, "NZD": 20, "USD": 0, ...}
  }]
}
```

Bundles without `parentVariantId` are filtered out.

## Slot matching + pricing math

For each bundle (sorted by AUD discount desc):
1. Slots = one per `productId` (single-product slot) + `option1Ids` and
   `option2Ids` as multi-product slots if non-empty.
2. Greedy fill loop: each slot must match a cart line whose product is in the
   slot's set with remaining quantity. If satisfied, consume quantities and
   loop to try matching again.
3. Per match, compute `childrenSum = sum(cost.amountPerQuantity * consumedQty)`.
4. Currency = first cart line's `cost.amountPerQuantity.currencyCode`.
5. `percent = clamp((discountAmounts[currency] / childrenSum) * 100, 0, 100)`,
   rounded to 4 decimals.
6. Emit `linesMerge { cartLines, parentVariantId, title, price: {percentageDecrease: {value: percent}}, attributes: [{key: "Original Price", value: formatMoney(childrenSum, currency)}] }`.

If `discountAmounts[currency]` is 0 or missing, no price adjustment is applied
(merged line shows children's sum).

## Install + scope

- One-time per shop: click "Install cart transform" in the admin page. Backend
  calls `cartTransformCreate(functionId)`, stores the returned cart transform
  GID in the app-installation `$app:cart_transform_id` metafield.
- Required scope: `write_cart_transforms` (in `shopify.app.toml`).

## Gotchas

- `cartTransform(id:)` is NOT a top-level Admin GraphQL query - use
  `node(id:) { ... on CartTransform { ... } }`.
- `setMetafield` JSON.stringifies values, so a stored GID becomes
  `"gid://..."` (with literal quotes). `getCartTransformId` JSON-parses
  defensively.
- `MergeOperation.price` only supports `percentageDecrease` - no absolute
  price set, no compareAt. The "Original Price" comparison is done via cart
  line attribute (theme-dependent rendering).
- Webhook subscriptions for `metaobjects/*` must include
  `filter = "type:lubricant_bundle"`.

## Deploy

- Function changes -> `shopify app deploy`.
- `app/` changes (webhook handler, admin route, helpers) -> git push to
  Render (`application_url = https://honey-birdette-checkout-amd.onrender.com`).
- Scope changes -> `shopify app deploy` + user re-auths on next embedded
  app load.

## Don't run both at once

The cart transform bakes the discount into the merged line. The separate v2
discount function (`bundle-discount-v2`) applies the same discount as an
order-level discount. Running both = double discount. Disable v2 in admin
when using the cart transform.

## User preferences

- No em dashes anywhere (prose, code, comments). Use a hyphen.
- Be explicit about which deploy step each change needs.
