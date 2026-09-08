# Webhook Monitor - Handoff

Paste into a fresh Claude chat opened in this repo to build the webhook
monitoring dashboard in the AMD Checkout app.

## Status (8 Sep 2026)

Built, lint-clean, production build passes, classifier + DB round trip tested
locally. Not yet deployed. To go live:

1. `git push` (Render redeploys the backend and runs `prisma migrate deploy`).
2. Render dashboard: set `WEBHOOK_MONITOR_SECRET` on the web service AND the
   new `webhook-monitor-maintenance` cron (Blueprint sync will create the cron).
3. `shopify app deploy` to release the new TOML subscriptions. App-config
   subscriptions apply to every install on release; no re-auth needed.
4. Open Kibo Checker's neighbour in the nav: "Webhook monitor".

Files: `app/lib/webhookMonitor.server.js`, `app/routes/webhooks.jsx`,
`app/routes/app.webhook-monitor.jsx`,
`app/routes/api.webhook-monitor.queue-depth.jsx`,
`app/routes/api.webhook-monitor.maintenance.jsx`,
`scripts/webhook-monitor-cron.mjs`, `prisma/migrations/20260908115749_webhook_monitor`.

Note on the legacy apps: the admin's custom apps (Percentages, Percentages
App, Percentages2, PercWebHooks) hold the subscriptions that feed the legacy
processor. Webhook payloads carry no "caused by app" field, so this monitor
cannot attribute a delivery to whichever app or integration made the change;
`source` is a tag/source_name guess only. Reducing THEIR volume means putting
a `filter` on their `orders/updated` subscription (e.g. exclude closed orders)
from inside that app's credentials, not from this one.

## Why this exists (incident, 8 Sep 2026)

The legacy backend (separate system, not this repo) receives Shopify webhooks,
writes each one as a JSON file on a web server, and processes the folder. On
8 Sep the AU, US and EU stores all stopped draining. AU alone had ~5,000 files
queued. Nobody had visibility into what was arriving or why.

What the Admin API showed for AU that evening (8:00pm to 9:35pm AEST):

- 182 `orders/updated`-class changes in 45 minutes, only 13 of them new orders.
- ~90% of order updates were Australia Post tracking scans. Shopify polls the
  carrier and writes every new scan in one burst, e.g. 44 separate orders
  updated inside 25 seconds at 8:27pm. Each write fires `orders/updated`.
  The same order fires again on every later scan (one order fired 5 times
  since Sunday). None of these change anything a backend cares about.
- Kibo fulfils in batches of ~10 orders, each producing `fulfillments/create`,
  two `orders/updated` (fulfil + archive) and a `customers/update`.
- Omneo CX writes the `omneo.balance` metafield on customers with no other
  activity, plus creates/edits customers during manual imports
  (`cx-manual-import` tag). Each metafield write fires `customers/update`.
  Omneo never touches orders.
- Inventory webhooks were only order placements decrementing stock.
- Tracking `happenedAt` is stored 10h earlier than reality (AEST offset bug in
  the AusPost integration). Cosmetic, but don't trust it for timing.

The legacy backend is believed to be on a 2021 API version. Unsupported
versions are silently forwarded to the oldest supported version, so payload
shapes may not match what its parser expects.

Tonight's triage script (classifies a folder of saved webhook JSON files) is
at `scripts/webhook_triage.py` if it was copied in; otherwise recreate from
the "tracking-only" heuristic below.

## Goal

Give the team a live view of what Shopify is emitting per store, per topic,
per minute, and which events are noise, so the next backlog is diagnosed in
one screen instead of by hand.

This app is installed on all four regions (AU/US/UK/EU) and already runs on
Render with SQLite + Prisma, so it is the natural home. It only OBSERVES.
It does not replace or feed the legacy processor.

Limitation to state up front: Shopify delivers webhooks per app, so this
shows what Shopify sends, not whether the legacy backend processed it. The
optional queue-depth feed (below) closes that gap.

## What to build

### 1. Subscribe this app to the noisy topics (log only)

`shopify.app.toml` already has `[webhooks] api_version = "2026-01"` and one
metaobject subscription. Add:

```toml
  [[webhooks.subscriptions]]
  topics = [
    "orders/create", "orders/updated", "orders/cancelled",
    "fulfillments/create", "fulfillments/update",
    "fulfillment_events/create",
    "customers/create", "customers/update",
    "inventory_levels/update",
  ]
  uri = "/webhooks"
```

Scopes: `write_orders`, `write_customers`, `write_inventory`,
`read_fulfillments` are already granted. `fulfillment_events/create` needs
`read_fulfillments` (have). Check Partners > app > "Protected customer data"
is approved for orders/customers topics, otherwise PII fields arrive
redacted (ids still arrive, which is all we store anyway).

Redeploy with `shopify app deploy`, then reinstall/re-auth on each region so
`afterAuth -> registerWebhooks` picks up the new topics. Verify with the
GraphQL explorer page (`/app/graphql`): `webhookSubscriptions(first: 50)`.

### 2. Handler: record and return, never process

`app/routes/webhooks.jsx` currently throws 404 on unknown topics and
requires `admin`. Add the new topics to the switch BEFORE that default.
Each case must do one cheap DB insert and return 200 well under 5 seconds.
No Admin API calls in the handler.

Headers to capture (via `request.headers.get`, before/alongside
`authenticate.webhook`):

- `X-Shopify-Webhook-Id` (dedupe key; Shopify retries the same id)
- `X-Shopify-Event-Id`
- `X-Shopify-Triggered-At` (when Shopify emitted it; compare to receivedAt
  for delivery lag)
- `X-Shopify-Api-Version`

Store NO PII. Ids, timestamps, statuses, tags, counts and a fingerprint only.

### 3. Prisma model

```prisma
// One row per webhook delivery this app receives. Observation only.
model WebhookEvent {
  id            String   @id @default(cuid())
  shop          String
  topic         String            // e.g. ORDERS_UPDATED
  webhookId     String   @unique  // X-Shopify-Webhook-Id, dedupes retries
  eventId       String?
  resourceType  String            // order | customer | fulfillment | inventory_level
  resourceId    String            // numeric id as string
  resourceName  String?           // order name, else null
  triggeredAt   DateTime?         // X-Shopify-Triggered-At
  receivedAt    DateTime @default(now())
  resourceUpdatedAt DateTime?     // payload.updated_at
  classification String           // see below
  fingerprint   String            // hash of the fields that matter
  repeatOfPrev  Boolean  @default(false) // same fingerprint as previous row for this resource
  payloadBytes  Int
  source        String?           // best-effort: kibo | omneo | loop | shopify | unknown

  @@index([shop, receivedAt])
  @@index([shop, topic, receivedAt])
  @@index([shop, resourceType, resourceId, receivedAt])
}

// Optional: legacy backend queue depth, posted by a cron on that server.
model WebhookQueueSample {
  id        String   @id @default(cuid())
  shop      String
  files     Int
  oldestAge Int?     // seconds
  sampledAt DateTime @default(now())

  @@index([shop, sampledAt])
}

// Hourly rollup so raw rows can be pruned.
model WebhookHourly {
  id        String   @id @default(cuid())
  shop      String
  topic     String
  classification String
  hour      DateTime
  count     Int
  repeats   Int

  @@unique([shop, topic, classification, hour])
}
```

Retention: raw `WebhookEvent` rows pruned after 3 days, `WebhookHourly` kept
90 days. Busy nights are ~20k rows/day/region, so 4 regions x 3 days fits
the 1GB Render disk with room. Prune inside the existing hourly Kibo sweep
cron or a new cron in `render.yaml`.

### 4. Classification (the whole point)

Put in `app/lib/webhookMonitor.server.js`. Pure functions, unit-testable.

Orders (`orders/updated`):

- `new_order` - `created_at` within 60s of `updated_at`
- `cancelled` - `cancelled_at` set
- `refund` - a refund `created_at` after `closed_at` (or any refund if open)
- `fulfilled` - `fulfillment_status` changed vs previous row's fingerprint
- `tracking_only` - `fulfillment_status == fulfilled`, `closed_at` set,
  `financial_status` in paid/partially_refunded/refunded, `updated_at` more
  than 5 minutes after `closed_at`, no refund after `closed_at`
- `tag_or_note` - fingerprint differs only in tags/note
- `other`

Order fingerprint = sha1 of JSON of: `financial_status`, `fulfillment_status`,
`closed_at`, `cancelled_at`, `tags`, `note`, `refunds.length`,
`fulfillments.map(f => f.status + f.tracking_number)`, `total_price`.
Same fingerprint as previous row for that order = `repeatOfPrev = true`.
That flag is the "noise" count on the dashboard.

Customers (`customers/update`):

- `created` - `created_at` within 60s of `updated_at`
- `order_placed` - `orders_count` or `total_spent` changed vs previous
- `contact_change` - email/phone/address count changed (hash only, no values)
- `tags` - only tags changed
- `silent` - fingerprint identical to previous row. This is Omneo metafield
  writes (the payload has no metafields, so a bump with nothing visible
  changed is the signature).

Customer fingerprint = sha1 of: `orders_count`, `total_spent`, `tags`,
`state`, `addresses.length`, sha1(email), sha1(phone), `email_marketing_consent.state`,
`sms_marketing_consent.state`.

Fulfillments / fulfillment events: record `status`, `shipment_status`,
tracking company. Classification = status.

Inventory: record `inventory_item_id`, `location_id`, `available`.
Classification = `decrement` / `increment` / `zero` vs previous row.

`source` is best-effort from the payload: `tags` containing `pos-order`,
`youpay`, customer tags `cx-manual-import` etc. Leave `unknown` when unsure.

### 5. Dashboard page `/app/webhook-monitor`

Add to `NavMenu` in `app/routes/app.jsx`. Polaris. Loader reads the DB only.
Shop selector (AU/US/UK/EU, default = embedded shop), window selector
(15m / 1h / 6h / 24h / 7d), auto-refresh every 30s.

Cards, top to bottom:

1. **Totals for the window**: events, events/min, % flagged noise
   (`tracking_only` + `silent` + `repeatOfPrev`), median delivery lag
   (receivedAt - triggeredAt). Big numbers.
2. **Timeline**: stacked bar per minute (or per hour on long windows), one
   colour per topic. This is where bursts like "44 in 25 seconds" show.
3. **By topic x classification**: table, count and % of total. Sort desc.
4. **Top repeated resources**: resources with the most rows in the window,
   with how many were `repeatOfPrev`. Link to the order/customer in admin.
5. **Legacy queue depth** (if samples exist): line chart of `files` over
   time per shop, current value, oldest file age. Red if rising for 15 min.
6. **Recent events**: last 100 rows, filterable by topic and classification.

Use Polaris `DataTable`, `Card`, `Badge`. For charts, inline SVG or
`@shopify/polaris-viz` (check bundle size before adding).

### 6. Optional queue-depth feed from the legacy server

`app/routes/api.webhook-monitor.queue-depth.jsx`, POST, guarded by a shared
secret header like the Kibo sweep (`WEBHOOK_MONITOR_SECRET` in
`render.yaml`, `sync: false`). Body: `{ shop, files, oldestAge }`.

On the legacy server, a one-line cron every minute:

```
curl -s -X POST "$APP_URL/api/webhook-monitor/queue-depth" \
  -H "x-webhook-monitor-secret: $SECRET" -H "content-type: application/json" \
  -d "{\"shop\":\"honey-birdette-2.myshopify.com\",\"files\":$(find /path/to/queue -type f | wc -l)}"
```

## Files to touch

- `shopify.app.toml` - new subscriptions
- `app/routes/webhooks.jsx` - record cases
- `app/lib/webhookMonitor.server.js` - classify, fingerprint, record, rollup, prune
- `prisma/schema.prisma` + migration
- `app/routes/app.webhook-monitor.jsx` - dashboard
- `app/routes/api.webhook-monitor.queue-depth.jsx` - optional feed
- `app/routes/app.jsx` - nav link
- `render.yaml` - secret + prune cron
- `scripts/webhook-monitor-prune.mjs` - if a separate cron is used

## Verification

1. Deploy, re-auth AU, confirm `webhookSubscriptions` lists the new topics.
2. Place a test order or edit a customer tag on AU; row appears within
   seconds with the right classification.
3. Leave running through one evening. The 8pm to 9pm AEST AusPost batch
   should show as a `tracking_only` spike on the timeline with
   `repeatOfPrev` high. If it doesn't, the classifier is wrong.
4. Cross-check a 15 minute window against
   `ordersCount(query: "updated_at:>=... AND updated_at:<...")` in the
   GraphQL explorer. Counts should match within a few.

## Out of scope

- Fixing or replacing the legacy processor.
- Replaying or forwarding webhooks.
- Storing payloads. If a payload is ever needed, add a per-shop "capture
  next N payloads" toggle later, never by default.
