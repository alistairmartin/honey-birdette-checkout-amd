# Deploying the Checkout (AMD) admin app + running the `_client_info` cleanup

This app is a Shopify **embedded admin app** (Remix). The checkout *extensions*
run on Shopify's infrastructure, but the embedded admin pages - including the
**Client info cleanup** tool - need a live server at the app's `application_url`.
Right now that URL is a dead `trycloudflare` dev tunnel, which is why the
interface "doesn't work". This guide hosts it on Render with a stable URL.

## What's already done in the repo

- New route `app/routes/app.client-info-cleanup.jsx` - scans orders from the
  last 4 days and removes the `_client_info` note attribute (dry-run + apply,
  resumable in batches, with cost-based throttle handling).
- `write_orders` added to `[access_scopes]` in `shopify.app.toml`.
- Shopify SDKs upgraded: `shopify-api` 13, `shopify-app-remix` 4, Prisma 6,
  Polaris 13. Admin API version is now `2026-01`.
- `application_url` / `redirect_urls` in `shopify.app.toml` point at the planned
  Render URL `https://honey-birdette-checkout-amd.onrender.com`.
- `render.yaml`, `Dockerfile` (Node 20), and Prisma (`env("DATABASE_URL")`,
  SQLite on a persistent disk) are ready to deploy.

## 1. Host on Render

1. Push the current branch to GitHub (`origin` is already
   `alistairmartin/honey-birdette-checkout-amd`).
2. Render dashboard → **New → Blueprint** → select this repo. Render reads
   `render.yaml` and creates the `honey-birdette-checkout-amd` web service with a
   1 GB persistent disk at `/data`.
3. Set the one secret it asks for: **`SHOPIFY_API_SECRET`** - from Shopify
   Partners → this app → *Client credentials* → API secret key.
4. Apply / deploy. Confirm the live URL is
   `https://honey-birdette-checkout-amd.onrender.com`.
   - If Render appended a suffix (name already taken), update **both**
     `SHOPIFY_APP_URL` in `render.yaml` and `application_url` +
     `redirect_urls` in `shopify.app.toml` to the real URL, then redeploy.

## 2. Push the app config to Shopify

```bash
shopify app deploy
```

This publishes the new `application_url`, `redirect_urls`, `write_orders` scope,
and API versions.

> ⚠️ `shopify app deploy` also bundles **every extension** under `extensions/`.
> Check `git status` and the `extensions/` folder beforehand so the deployed app
> version contains exactly the extensions you intend to ship.

## 3. One-time Shopify settings

- **Re-grant scopes:** `write_orders` is new. The first time the app is opened
  in each store after the deploy, the merchant must approve the added scope.
- **Protected customer data:** reading orders requires approved access. In
  Shopify Partners → this app → *API access → Protected customer data access*,
  enable access to orders/customer data. Without it the cleanup query fails.
- **Install on all 4 stores** (AU, US, UK, EU) if not already installed.

## 4. Run the cleanup

In each store's admin, open the app → **Client info cleanup** in the nav:

1. **Dry run** - counts orders that have `_client_info`, changes nothing.
2. **Apply - remove attribute** - re-runs and removes the attribute, preserving
   every other note attribute on each order.

The tool processes orders in ~25-second batches and resumes automatically, so it
survives request timeouts on large order volumes. Repeat per store.

## 5. Kibo Checker

The **Kibo Checker** page (app nav) finds orders that exist in Shopify but never
imported into Kibo and shows a likely reason + fix. Detection is a reconciliation
sweep (list recent Shopify orders, ask Kibo which it has), run hourly by a Render
cron **and** on demand via the page's "Run sweep now" button.

**Identify-only by default.** The reimport capability is built but disabled
(`KIBO_REIMPORT_ENABLED` unset/`false`) - the page only surfaces missing orders.
The Kibo app therefore only needs **Order read** access for now. To turn reimport
on later: set `KIBO_REIMPORT_ENABLED=true` on the web service **and** grant the
Kibo app the **Order create/import** behaviour. Reimport re-checks Kibo first, so
an order the warehouse already keyed in by hand is never duplicated.

### Multi-region config

The app runs across **4 regions - AU, US, UK, EU** - each a separate Shopify
store with its **own Kibo instance/credentials**. All four are held in a single
`KIBO_REGIONS` JSON env var keyed by myshopify domain. Each store's Kibo Checker
page resolves its own region from `session.shop`; the hourly cron sweeps every
configured region.

Ready-to-fill skeleton for all 4 stores (paste into the `KIBO_REGIONS` value -
JSON may be multi-line in a Render env var, `JSON.parse` ignores the whitespace):

```jsonc
{
  "honey-birdette-2.myshopify.com":   { "_region": "AU", "authHost": "", "apiHost": "", "clientId": "", "clientSecret": "", "tenantId": "", "siteId": "" },
  "honey-birdette-usa.myshopify.com": { "_region": "US", "authHost": "", "apiHost": "", "clientId": "", "clientSecret": "", "tenantId": "", "siteId": "" },
  "honey-birdette-uk.myshopify.com":  { "_region": "UK", "authHost": "", "apiHost": "", "clientId": "", "clientSecret": "", "tenantId": "", "siteId": "" },
  "honey-birdette-eu.myshopify.com":  { "_region": "EU", "authHost": "", "apiHost": "", "clientId": "", "clientSecret": "", "tenantId": "", "siteId": "" }
}
```

(`_region` is just a human label, ignored by the code. Fill the 6 real fields
per store; example values: `authHost` `https://home.mozu.com`, `apiHost`
`https://t1234.tp1.mozu.com`, `tenantId` `1234`, `siteId` `5678`.)

### Environment variables (set in the Render dashboard, `sync:false`)

On the **web** service:

| Var | Purpose |
| --- | --- |
| `KIBO_REGIONS` | JSON map (above) of all 4 regions' Kibo settings |
| `KIBO_SWEEP_SECRET` | shared secret the cron presents to `/api/kibo-sweep` |

On the **kibo-sweep cron** service: `KIBO_SWEEP_SECRET` (same value) plus
`APP_URL` (already defaulted in `render.yaml`). The cron sweeps all regions
present in `KIBO_REGIONS`; no per-shop config needed.

A region is only active once its `KIBO_REGIONS` entry has all six fields - until
then that store's page shows "Kibo is not configured for <shop>" and
sweeps/reimports are disabled there (other regions are unaffected).

### Confirm against the Kibo sandbox - per region (see `app/lib/kibo.server.js`)

Each region's Kibo could differ, so verify for **each** of AU/US/UK/EU:

- exact auth token endpoint / API host base path,
- the `externalId` convention the Shopify connector writes (numeric id vs
  `#name`) - check against one known-good imported order in that region,
- the minimum required `createOrder` import fields for that tenant.

These are isolated in `app/lib/kibo.server.js` / `kiboChecker.server.js` so
finalizing them is a contained edit. `prisma migrate deploy` ships the new
`KiboFailedOrder` table automatically via the `setup` script.

## Notes

- `DATABASE_URL` is `file:dev.sqlite` locally and `file:/data/prod.sqlite` on
  Render (persistent disk). Sessions survive restarts.
- `shopify app dev` will overwrite `application_url` with a temporary tunnel.
  After a dev session, restore the Render URL before `shopify app deploy`.
