# Size Preference — Customer Account UI extension

Renders a **My size profile** card on the customer account **Profile** page
(`customer-account.profile.block.render`). Customers save bra band + cup, thong,
brief and dress sizes as chips; the values persist to **store-owned** customer
metafields under the `size_preference` namespace so the theme can read them
everywhere (collection quick-add, PDP pre-select).

## How it fits together

```
CA UI extension (this)  ──fetch──►  /api/size-preference (this app)  ──Admin API──►  customer metafields
   getSessionToken()                authenticate.public.customerAccount            namespace "size_preference"
```

- The extension **can't write Admin metafields directly**, so reads/writes go
  through `app/routes/api.size-preference.jsx` in the AMD Checkout Remix app.
- Auth is the extension's signed **customer-account session token** (Bearer). The
  route derives the customer GID from `sessionToken.sub` and the shop from
  `sessionToken.dest` — the body can't spoof either.
- We do **not** reuse `[app_proxy]` in `shopify.app.toml` — it's already taken by
  omeno-birthday and points at a different Render service. This extension calls the
  app's own `application_url` directly (needs `network_access`).

## Deploy checklist

1. **Create the 5 metafield definitions** (once) — open the app's **Metafield
   definitions** page and click **Install metafields** on the "Size preference" group
   (idempotent). Manual mutations are also in
   `info/design_handoff_size_preference/METAFIELDS.md`. The backend only sets/deletes
   values; it assumes the definitions exist.
2. **Deploy** with `shopify app deploy` (bundles this extension + the app backend).
3. **Set the `api_url` setting** on the extension to the app base URL
   (default `https://honey-birdette-checkout-amd.onrender.com`, no trailing slash).
4. **Place the block** on the Profile page via the customer account **editor**
   (profile blocks aren't auto-injected) and approve **network access** when prompted.

## Platform constraint (fidelity)

Customer-account UI can't render arbitrary colours (`background` is limited to
`transparent | base | subdued`), so the design's solid-black selected chips are
approximated: selected chips use a filled `subdued` background + bold text, sharp
corners (`cornerRadius="none"`). The account bar + modal from the prototype is
rendered as an inline card here (the native block model); swap to `Modal` if a true
bar-opens-modal interaction is required.

## Files

- `src/SizeProfileBlock.tsx` — the extension UI + read/save logic.
- `app/routes/api.size-preference.jsx` — backend read/write (in the app, not here).
- `locales/en.default.json` — copy.
</content>
