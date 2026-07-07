# Size Preference — Customer Metafield Definitions

Store-owned customer metafields under the `size_preference` namespace. **Store-owned**
(not app-reserved `$app`) so the theme can read them in Liquid and via the Storefront API.

## Summary

| Namespace         | Key     | Type                    | Owner    | Allowed values (AU)            |
|-------------------|---------|-------------------------|----------|--------------------------------|
| `size_preference` | `band`  | `single_line_text_field`| Customer | `8` `10` `12` `14` `16`        |
| `size_preference` | `cup`   | `single_line_text_field`| Customer | `A` `B` `C` `D` `DD` `E` `F` `G`|
| `size_preference` | `thong` | `single_line_text_field`| Customer | `XS` `S` `M` `L` `XL` `XXL`    |
| `size_preference` | `brief` | `single_line_text_field`| Customer | `XS` `S` `M` `L` `XL` `XXL`    |
| `size_preference` | `dress` | `single_line_text_field`| Customer | `6` `8` `10` `12` `14` `16`    |

- All keys are individually nullable/optional.
- **Bra preference is valid only when BOTH `band` and `cup` are set.**
- Access: `storefront: PUBLIC_READ` (theme/Liquid + Storefront API can read the logged-in
  customer's own values) and `admin: MERCHANT_READ_WRITE`.

## Preferred-size resolution (by product type)

| Product type | Resolved size string        | Example |
|--------------|-----------------------------|---------|
| bra          | `band` + `cup` (concatenated)| `10D`   |
| thong        | `thong`                     | `M`     |
| brief        | `brief`                     | `M`     |
| dress        | `dress`                     | `12`    |

Product type should come from the Shopify product type or a product tag/metafield.

## Create the definitions (Admin GraphQL, API 2026-01)

Run each once (e.g. in the GraphQL App / admin API). `single_line_text_field` `choices`
validation enforces the allowed values and gives merchants a dropdown in admin.

```graphql
mutation CreateBand {
  metafieldDefinitionCreate(definition: {
    namespace: "size_preference"
    key: "band"
    name: "Size preference — Bra band"
    description: "Customer's saved bra band size (AU)."
    type: "single_line_text_field"
    ownerType: CUSTOMER
    validations: [{ name: "choices", value: "[\"8\",\"10\",\"12\",\"14\",\"16\"]" }]
    access: { admin: MERCHANT_READ_WRITE, storefront: PUBLIC_READ }
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateCup {
  metafieldDefinitionCreate(definition: {
    namespace: "size_preference"
    key: "cup"
    name: "Size preference — Bra cup"
    description: "Customer's saved bra cup size (AU)."
    type: "single_line_text_field"
    ownerType: CUSTOMER
    validations: [{ name: "choices", value: "[\"A\",\"B\",\"C\",\"D\",\"DD\",\"E\",\"F\",\"G\"]" }]
    access: { admin: MERCHANT_READ_WRITE, storefront: PUBLIC_READ }
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateThong {
  metafieldDefinitionCreate(definition: {
    namespace: "size_preference"
    key: "thong"
    name: "Size preference — Thong"
    description: "Customer's saved thong size (AU)."
    type: "single_line_text_field"
    ownerType: CUSTOMER
    validations: [{ name: "choices", value: "[\"XS\",\"S\",\"M\",\"L\",\"XL\",\"XXL\"]" }]
    access: { admin: MERCHANT_READ_WRITE, storefront: PUBLIC_READ }
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateBrief {
  metafieldDefinitionCreate(definition: {
    namespace: "size_preference"
    key: "brief"
    name: "Size preference — Brief"
    description: "Customer's saved brief size (AU)."
    type: "single_line_text_field"
    ownerType: CUSTOMER
    validations: [{ name: "choices", value: "[\"XS\",\"S\",\"M\",\"L\",\"XL\",\"XXL\"]" }]
    access: { admin: MERCHANT_READ_WRITE, storefront: PUBLIC_READ }
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateDress {
  metafieldDefinitionCreate(definition: {
    namespace: "size_preference"
    key: "dress"
    name: "Size preference — Dress"
    description: "Customer's saved dress size (AU)."
    type: "single_line_text_field"
    ownerType: CUSTOMER
    validations: [{ name: "choices", value: "[\"6\",\"8\",\"10\",\"12\",\"14\",\"16\"]" }]
    access: { admin: MERCHANT_READ_WRITE, storefront: PUBLIC_READ }
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}
```

## Reading in the theme (Liquid)

Only the currently-logged-in customer's own values are exposed to Liquid:

```liquid
{%- assign band  = customer.metafields.size_preference.band  | default: '' -%}
{%- assign cup   = customer.metafields.size_preference.cup   | default: '' -%}
{%- assign thong = customer.metafields.size_preference.thong -%}
{%- assign brief = customer.metafields.size_preference.brief -%}
{%- assign dress = customer.metafields.size_preference.dress -%}

{%- comment -%} bra size = band + cup, only when both set {%- endcomment -%}
{%- if band != blank and cup != blank -%}
  {%- assign bra = band | append: cup -%}  {%- comment -%} e.g. 10D {%- endcomment -%}
{%- endif -%}
```

Storefront API (for guest → account merge, JS quick-add, etc.) reads the same via
`customer { metafield(namespace: "size_preference", key: "band") { value } }`.

## Writing the values

Customer-account UI extensions can't write Admin metafields directly. Writes go through
the app backend using `metafieldsSet` on the `Customer` owner:

```graphql
mutation SetSizePreference($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { namespace key value }
    userErrors { field message code }
  }
}
```

with each input shaped as:

```json
{
  "ownerId": "gid://shopify/Customer/1234567890",
  "namespace": "size_preference",
  "key": "band",
  "type": "single_line_text_field",
  "value": "10"
}
```

To **clear** a category, delete that metafield (`metafieldsDelete`) rather than writing an
empty string — an empty value fails the `choices` validation.
</content>
</invoke>
