# Email Banner Metafield - Handoff for the email templates repo

## What changed

The weekly campaign banner image URL is no longer hardcoded in each notification
email template. It now lives in a **shop metafield** that is updated from the
checkout app's admin ("Email banner" page), and the same value is written to
**all four regional stores** (AU, UK, EU, US) in one click.

- **Owner type:** Shop
- **Namespace:** `email`
- **Key:** `banner_url`
- **Type:** `url`
- **Liquid access:** `{{ shop.metafields.email.banner_url }}`

Each store holds its own copy of the metafield, so the identical Liquid works in
every region with no region conditionals.

## What the email repo needs to update

Every notification email template currently starts with something like:

```liquid
{%- comment -%} --- IMAGE BANNER --- {%- endcomment -%}
{%- comment -%} Update on AU Shopify Files 'email-banner.png' {%- endcomment -%}
{%- assign image_banner_url = "https://cdn.shopify.com/s/files/1/0585/9581/files/Shopify_Banner_1.jpg?v=1785888318" -%}
```

Replace that block, in **every template**, with:

```liquid
{%- comment -%} --- IMAGE BANNER --- {%- endcomment -%}
{%- comment -%} Set weekly via the checkout app > Email banner page. Do not hardcode. {%- endcomment -%}
{%- assign image_banner_url = shop.metafields.email.banner_url -%}
{%- if image_banner_url == blank -%}
  {%- assign image_banner_url = "https://cdn.shopify.com/s/files/1/0585/9581/files/Shopify_Banner_1.jpg?v=1785888318" -%}
{%- endif -%}
```

Notes:

- The `blank` fallback protects any store where the metafield has not been set
  yet (or was cleared). Point it at a safe evergreen banner, not a dated
  campaign. Once all stores are confirmed set, the fallback can stay as a
  belt-and-braces default.
- Everything downstream of the assign is unchanged: whatever markup currently
  renders `{{ image_banner_url }}` (the `<img src>`, links, alt text) stays as
  is.
- Only templates that render the banner need touching. Subject lines and
  templates without the banner are unaffected.

## Where to apply it

Notification templates are per store. The updated templates need to be pushed
to **all four stores** (Settings > Notifications in each admin, or however the
email repo deploys them):

| Region | Store |
| --- | --- |
| AU | honey-birdette-2.myshopify.com |
| UK | honey-birdette-uk.myshopify.com |
| EU | honey-birdette-eu.myshopify.com |
| US | honeybirdette-us.myshopify.com |

This is a one-time change per template. After it, weekly campaign swaps involve
no template edits at all.

## New weekly workflow (for whoever runs campaigns)

1. Upload the new banner image to Shopify Files (the checkout app's **Asset
   uploader** page does this and returns the CDN URL). Upload a fresh file each
   week; a new unique URL is what prevents email clients serving a cached old
   banner.
2. Open the checkout app > **Email banner** page.
3. Paste the CDN URL, check the preview, click **Apply to all stores**.
4. The page shows per-store confirmation and the current value on each store.

## Verifying

- In any store admin: Settings > Custom data > Shop > "Email banner URL" shows
  the current value (it is merchant-editable there too).
- Send a test notification (Settings > Notifications > pick a template > Send
  test) and confirm the banner renders from the metafield URL.
- If a template shows the fallback image instead, that store's metafield is
  blank: re-run **Apply to all stores** from the Email banner page.

## Gotchas

- The metafield type is `url`, so only a full `https://` URL is accepted; the
  app page validates this before saving.
- Do not reference the metafield as `$app` or any prefixed namespace. It is a
  plain store-owned `email` namespace precisely so the Liquid stays
  `shop.metafields.email.banner_url`.
- Emails already sent keep whatever URL they were rendered with; the metafield
  only affects emails generated after the change.
