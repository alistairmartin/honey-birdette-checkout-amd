# Size Preference - Theme handoff

This is what the **theme** needs to build to consume the customer Size Profile.
The account side (customer-account UI extension + app backend) is done: a logged-in
customer can save their sizes, and the values live on **store-owned customer metafields**.
Your job is the read + pre-select side (collection quick-add, PDP variant pre-select),
plus the guest (logged-out) experience.

Store: Honey Birdette AU (www.honeybirdette.com).

---

## 1. Data model

- **Owner:** Customer
- **Namespace:** `size_preference`
- **Type:** every key is `single_line_text_field` with a `choices` validation
- **Access:** `storefront = PUBLIC_READ` (so Liquid / Storefront API can read the
  logged-in customer's own values), `admin = PUBLIC_READ_WRITE`, `customerAccount = READ_WRITE`
- A key is **absent/empty when the customer hasn't set it** (empty string is never stored -
  it fails the choices validation - so "not set" = the metafield does not exist).

### The 12 keys and their exact allowed values

| Key | Allowed values (match these strings exactly) |
|---|---|
| `band` | `8`, `10`, `12`, `14`, `16` |
| `cup` | `A`, `B`, `C`, `D`, `DD`, `E`, `F`, `G` |
| `thong` | `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL` |
| `brief` | `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL` |
| `suspender` | `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL` |
| `corset` | `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL` |
| `skirt` | `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL` |
| `swimsuit` | `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL` |
| `top` | `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL` |
| `bodysuit` | `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL` |
| `hosiery` | `S`, `M`, `L` |
| `robe` | `S/M`, `M/L` |
| `latex` | `S/M`, `M/L` |

Bra size = `band` + `cup` together (e.g. `10` + `D` = "10D"). Only treat the bra size as
set when BOTH are present.

These `choices` were set from the real AU variant options per product type (queried live),
not guessed.

---

## 2. Product type -> preference key mapping

On a PDP / quick-add, pick the preference key from the product's **product type**:

| Product type | Preference key | How the variant is chosen |
|---|---|---|
| Thong | `thong` | match letter to the `Size` option |
| Brief | `brief` | match letter to the `Size` option |
| Suspender | `suspender` | match letter to the `Size` option |
| Corset | `corset` | match letter to the `Size` option |
| Skirt | `skirt` | match letter to the `Size` option |
| Swimsuit | `swimsuit` | match letter to the `Size` option |
| Top | `top` | match letter to the `Size` option |
| Hosiery | `hosiery` | match `S`/`M`/`L` to the `Size` option |
| Robe | `robe` | match `S/M` or `M/L` to the `Size` option |
| Latex | `latex` | match `S/M` or `M/L` to the `Size` option |
| Bra | `band` + `cup` | match `band` to `Size`, `cup` to `Cup` |
| Bodysuit | `bodysuit` OR `band`+`cup` | letter Size -> `bodysuit`; band+`Cup` option -> bra size (see section 3) |
| **Bustier, Chemise, Dress** | **`band` + `cup`** | see section 3 |

---

## 3. IMPORTANT - product types that can be band+cup (Bodysuit, Bustier, Chemise, Dress)

These product types are sold **two different ways** in the catalog: some as a single letter
`Size` (XXS-XXL), some as **band + cup** (bra sizing, e.g. `Size` = `10/12/14/16/18` plus a
`Cup` = `A-G` option). **Branch on the presence of a `Cup` option, not on the product type.**

**Rule (per product):**

1. If the product has a **`Cup`** option (numeric `Size` + `Cup`) -> treat as band+cup:
   - pre-select the `Size` option from `band`, the `Cup` option from `cup`
   - only pre-select when BOTH `band` and `cup` are set.
2. If the product has a **single letter `Size`** option and no `Cup`:
   - **Bodysuit** has its own `bodysuit` preference (letter XXS-XXL) - use it. (e.g. the Onyx
     Bodysuit is `XXS-XXL`.)
   - **Bustier, Chemise, Dress** do NOT have their own letter category - there is no stored
     preference, so leave the size unselected. (Accepted limitation: only their band+cup
     versions pre-select, from the saved bra size.)

If you later find a lot of letter-sized Bustier/Chemise/Dress traffic, ask the account side to
add those as letter categories too (same pattern as `bodysuit`).

> Note: the catalog has band+cup items up to **band 18**, but the bra `band` preference
> currently caps at `16`. A customer who wears band 18 cannot express it yet. Flag back to
> the account side if band 18 needs adding.

---

## 4. How to read the values

### Liquid (logged-in customer, their own profile)
```liquid
{%- assign band  = customer.metafields.size_preference.band.value -%}
{%- assign cup   = customer.metafields.size_preference.cup.value -%}
{%- assign thong = customer.metafields.size_preference.thong.value -%}
{%- comment -%} bra size only valid when both parts are set {%- endcomment -%}
{%- if band != blank and cup != blank -%}
  {%- assign bra_size = band | append: cup -%}
{%- endif -%}
```

### Storefront API (logged-in, via customer access token)
```graphql
query {
  customer {
    band: metafield(namespace: "size_preference", key: "band") { value }
    cup:  metafield(namespace: "size_preference", key: "cup")  { value }
    thong: metafield(namespace: "size_preference", key: "thong") { value }
    # ...one per key you need
  }
}
```

---

## 5. Matching variant options (be tolerant)

The catalog has some data-entry noise (stray casing like lowercase `s`, one-off combined
values like `XS/S`, `L/XL`). When matching a saved preference to a variant option value:

- compare **case-insensitively** and **trimmed**
- if there is no exact match, leave the option unselected (do not force a wrong size)
- for `robe` / `latex`, the stored value is already a combined range (`S/M`, `M/L`) - match it
  directly against the option value.

---

## 6. Guests (logged-out)

There is no metafield for guests. Mirror the saved profile in **`localStorage`** using the
same keys (`size_preference.<key>` or your own namespaced key), so the "shop in my size"
experience works before login, and reconcile to the customer metafields after login if you
want persistence. (This matches the original design handoff for the guest path.)

---

## 7. What is already built (do not duplicate)

- **Customer-account UI extension** (`extensions/size-preference`): renders "My size profile"
  in the account, lets the customer pick/save each size. It writes through the app backend.
- **App backend** (`app/routes/api.size-preference.jsx`): reads/writes the customer metafields
  with the customer-account session token. Values are validated against the same `choices`.
- **Metafield definitions**: all 12 are installed on the store with `storefront = PUBLIC_READ`.

The theme only needs to **read** and **pre-select** (plus the guest localStorage path). It
must use the **same `size_preference` namespace and keys** listed above.

---

## 8. TODO - other regions (US, UK, EU)

The definitions above exist on **AU only** so far. We still need to create the
`size_preference` definitions on the **US, UK and EU** stores.

Do NOT copy the AU `choices` verbatim - the size systems differ by region:
- **band / cup**: AU/UK use `8-16` bands; US uses `30-40` bands; EU uses `65-90` bands.
  Cup letters also differ (e.g. AU DD vs UK/US DD/E vs EU labelling).
- **dress / numeric apparel**: AU 6-16 vs US 2-12 vs UK 6-16 vs EU 34-44.
- **letter sizing (XXS-XXL)**: broadly shared but confirm per store.

For each region: query that store's real variant options per product type (same method
used for AU), set the `choices` from the actual data, then create the definitions with
`access = { storefront: PUBLIC_READ, customerAccount: READ_WRITE }` and **omit `admin`**
(the namespace pins admin to `PUBLIC_READ_WRITE`; passing admin errors).

---

## Quick checklist for the theme

- [ ] Read the 12 keys from `customer.metafields.size_preference.*`
- [ ] Collection quick-add: pre-select the size chip/variant from the matching key
- [ ] PDP: pre-select the variant option from the matching key
- [ ] Bodysuit/Bustier/Chemise/Dress: if the product has a `Cup` option, pre-select from
      `band`+`cup`; if it is a letter `Size`, use `bodysuit` for bodysuits and leave
      Bustier/Chemise/Dress unselected (no letter category for those)
- [ ] Case-insensitive / trimmed option matching; no forced wrong size
- [ ] Guest localStorage fallback with the same keys
