# Kibo API credentials needed - Kibo Checker app

We're adding a **Kibo Checker** tool to the Shopify admin app. For now it only
**identifies** orders that exist in Shopify but failed to import into Kibo (so we
hear about them within the hour instead of a day later). It needs **read-only**
Kibo API access **for each of our 4 regions** (each region is a separate Kibo
instance):

- **AU** - Shopify store `honey-birdette-2.myshopify.com`
- **US** - Shopify store `honey-birdette-usa.myshopify.com`
- **UK** - Shopify store `honey-birdette-uk.myshopify.com`
- **EU** - Shopify store `honey-birdette-eu.myshopify.com`

## What we need (6 values per region = 24 total)

| Field | What it is | Where it comes from in Kibo |
| --- | --- | --- |
| `clientId` | Application Key (Client ID) | Dev Center → Develop → Applications → (the app) → **Application Details** |
| `clientSecret` | Shared Secret | same Application Details view (secret - treat as a password) |
| `tenantId` | numeric Tenant ID for that region | Kibo Admin URL / tenant settings for that region |
| `siteId` | numeric Site ID for that region | Kibo Admin → site settings for that region |
| `authHost` | OAuth token host | Kibo-provided, e.g. `https://home.mozu.com` (confirm for our account) |
| `apiHost` | API / tenant pod host | Kibo-provided, e.g. `https://t<tenantId>.<pod>.mozu.com` (confirm per region) |

`clientId` + `clientSecret` may be the same across regions if one Dev Center
application is installed into all four tenants; `tenantId`, `siteId`, and the
hosts will differ per region. Please provide whatever applies for each region so
we don't have to assume.

## How to set this up in Kibo (for whoever has Dev Center access)

1. **Create (or reuse) an Application** in the Kibo **Dev Center**:
   Develop → Applications → create an app (e.g. "Shopify Kibo Checker").
   The **Application Key** and **Shared Secret** are on its Application Details
   view - those are our `clientId` / `clientSecret`.
2. **Grant behaviours** (this app's permissions): in the application record →
   Packages → Behaviors → Select Behaviors → add the **Order read** behaviour.
   That's all we need right now - the tool only reads orders, it does not modify,
   create, or delete anything in Kibo. (A later phase may add a reimport feature,
   which would also need **Order create/import** - not required today.)
3. **Install the application into each region's tenant/sandbox**: in the
   application record → Install → select that region's tenant. Repeat for AU,
   US, UK, EU (or install the one app into all four).
4. **Note the Tenant ID and Site ID** for each region (from the Kibo Admin for
   that region) and the **auth host + API host** Kibo gives for each instance.

## Format to send back

Easiest for us is one block per region, e.g.:

```
AU (honey-birdette-2):
  authHost     = https://home.mozu.com
  apiHost      = https://t1234.tp1.mozu.com
  clientId     = ...
  clientSecret = ...
  tenantId     = 1234
  siteId       = 5678

US (honey-birdette-usa): ...
UK (honey-birdette-uk):  ...
EU (honey-birdette-eu):  ...
```

Please send the **clientSecret** securely (password manager / secure note), not
in plain email/chat. We store these only as server environment variables on
Render (never committed to code).

## What happens with these (for context)

They go into one Render environment variable, `KIBO_REGIONS`, as JSON keyed by
store. Until then the page loads but shows "Kibo is not configured" and does
nothing. The tool is **read-only** against Kibo - it never writes to Kibo.
