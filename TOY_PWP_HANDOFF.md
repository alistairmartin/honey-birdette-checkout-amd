# Toy purchase-with-purchase (PWP) promo

Spend a per-currency threshold and get **50% off a promotional toy**. Runs for
5 weeks; the toy is swapped each week from an admin page. Week 1 is **Luna Black
(50277391)**.

Thresholds: **AUD 250 / USD 300 / GBP 200 / EUR 250**.

## How it works

Three pieces, one shared config object:

| Piece | Path | Job |
|------|------|-----|
| Discount **function** | `extensions/toy-pwp-discount` | Applies 50% off the toy line automatically once the cart subtotal meets the currency threshold. Reads config from the discount's `$app/function-configuration` metafield. |
| Checkout **UI extension** | `extensions/limited-offer` | The progress bar + "Add" button. Reads config from the Shop's `$app/limited_offer_config` metafield, shows progress to the threshold, and adds the toy to cart. |
| Admin **app route** | `app/routes/app.limited-offer.jsx` (+ `app/lib/limitedOffer.server.js`) | Holds the 5-week schedule and thresholds. "Activate" writes the active config to both metafields and creates the automatic discount the first time. |

**Answers to the client's questions**

- *How is the discount applied?* An automatic Shopify discount backed by a
  product-discount function. No codes; it applies in checkout when the cart
  qualifies and the toy is present.
- *How do we run the promo?* Activate week 1 from the admin page. The function
  + checkout bar go live immediately on that store.
- *How do we program it ongoing?* The admin page lists all 5 weeks. Each week,
  paste the toy's product ID, Save, and click **Activate**. One click swaps the
  toy everywhere (function + checkout bar).

### Decisions locked with the client

- Qualifying spend **includes** the toy (the cart subtotal is compared directly
  to the threshold).
- **Automatic discount** (not a code).
- Weekly swap is a **manual admin toggle** (no scheduler).
- **Separate stores per region** - deploy to each store and the per-currency
  threshold for that store applies.

### Config object (written to both metafields)

```json
{
  "enabled": true,
  "discountPercentage": 50,
  "thresholds": { "AUD": 250, "USD": 300, "GBP": 200, "EUR": 250 },
  "productId": "gid://shopify/Product/50277391",
  "variantIds": ["gid://shopify/ProductVariant/…"],
  "message": "50% off Luna Black",
  "week": 1,
  "product": { "title": "Luna Black", "productId": "…", "variantId": "…" }
}
```

The function matches the toy by `productId` (any variant of the product), so it
keeps working even if the toy has multiple variants. The checkout bar uses
`product.variantId` for the "Add" button.

## Deploy

This must be done **per regional store** (AU / US / UK / EU).

1. **Extensions** (function + checkout UI):
   ```bash
   cd extensions/toy-pwp-discount && npm install && npm run typegen
   cd ../.. && shopify app deploy
   ```
   `typegen` regenerates `extensions/toy-pwp-discount/generated/api.ts` from the
   input query (the dir is gitignored). `shopify app deploy` builds the function
   to wasm and ships both extensions.

2. **App backend** (admin page): deploys to Render via `git push` (see
   `DEPLOY.md`).

3. Add the **checkout UI block** to the checkout in the store's checkout editor
   (Settings → Checkout → Customize) if it isn't already placed.

## Run the promo

1. Open the app → **Toy purchase-with-purchase**.
2. Confirm **Function deployed** shows green. If not, finish the deploy step.
3. Set the **Discount %** and **thresholds** (defaults match the brief), Save.
4. Paste each week's toy product ID (week 1 = `50277391`), Save schedule.
5. Click **Activate** on week 1. This creates the automatic discount (first
   time) and writes the config. The checkout bar goes live immediately.
6. Each following week: click **Activate** on the next row to swap the toy.
7. **Pause promo** flips `enabled=false` everywhere without deleting anything;
   **Resume** turns it back on.

## Test checklist

- [ ] Cart below threshold: bar shows "Spend X more…", no discount.
- [ ] Add toy + cross threshold: toy line shows 50% off in checkout totals.
- [ ] Bar shows "unlocked" copy once threshold met.
- [ ] Toy already in cart: "Add" button shows "Added" and is disabled.
- [ ] Wrong currency (no threshold configured): bar hidden, no discount.
- [ ] Activate week 2: checkout bar + discount switch to the new toy.
- [ ] Function unit tests: `cd extensions/toy-pwp-discount && npm test`.

## Notes / caveats

- The discount function's `apiType` is auto-detected. If a store has multiple
  discount functions, the admin route prefers the one whose title matches
  "toy/pwp/purchase-with-purchase"; verify the **Discount** id shown on the
  admin page points at the right one after first activation.
- `npm run typegen` must be run before the first build on a fresh checkout
  (the `generated/` folder is gitignored, same as `bundle-discount`).
- Thresholds for all four currencies are stored even though each store charges
  in one currency, so the same config works everywhere.
- The config is read directly in the input query via
  `discount.metafield(namespace: "$app", key: "function-configuration")` - the
  function deliberately does **not** use an `[extensions.input.variables]` block
  (that feature requires matching `$variable` definitions in the query).
