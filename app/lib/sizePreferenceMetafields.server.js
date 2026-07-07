// Size Preference metafield group descriptor.
//
// 5 store-owned customer metafield definitions under the `size_preference`
// namespace (band, cup, thong, brief, dress). "Store-owned" (not app-reserved
// `$app`) + storefront PUBLIC_READ so the theme can read the logged-in customer's
// own values in Liquid / Storefront API.
//
// Registered in app/lib/metafieldDefinitions.server.js and surfaced on the
// Metafield definitions admin page. Pairs with the write route
// app/routes/api.size-preference.jsx and the CA UI extension.

export const SIZE_PREFERENCE_GROUP = {
  id: "size-preference",
  title: "Size preference",
  description:
    "Customer size profile (bra band + cup, thong, brief, dress). Read by the account extension and the theme for quick-add / PDP pre-select.",
  ownerType: "CUSTOMER",
  namespace: "size_preference",
  // `choices` validations enforce the allowed AU sizes and give merchants a
  // dropdown when editing the customer in admin.
  definitions: [
    {
      key: "band",
      name: "Size preference — Bra band",
      description: "Customer's saved bra band size (AU).",
      type: "single_line_text_field",
      choices: ["8", "10", "12", "14", "16"],
    },
    {
      key: "cup",
      name: "Size preference — Bra cup",
      description: "Customer's saved bra cup size (AU).",
      type: "single_line_text_field",
      choices: ["A", "B", "C", "D", "DD", "E", "F", "G"],
    },
    {
      key: "thong",
      name: "Size preference — Thong",
      description: "Customer's saved thong size (AU).",
      type: "single_line_text_field",
      choices: ["XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "brief",
      name: "Size preference — Brief",
      description: "Customer's saved brief size (AU).",
      type: "single_line_text_field",
      choices: ["XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "dress",
      name: "Size preference — Dress",
      description: "Customer's saved dress size (AU).",
      type: "single_line_text_field",
      choices: ["6", "8", "10", "12", "14", "16"],
    },
  ],
};
