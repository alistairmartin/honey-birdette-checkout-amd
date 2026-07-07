// Size Preference metafield group descriptor.
//
// Store-owned customer metafield definitions under the `size_preference`
// namespace: band, cup (bra), thong, brief, suspender, corset, skirt, swimsuit,
// top, bodysuit (letter XXS-XXL), hosiery (S-L) and robe, latex (combined S/M, M/L).
// Choices mirror the real AU variant options per product type. "Store-owned"
// (not app-reserved `$app`) + storefront PUBLIC_READ so the theme can read the
// logged-in customer's own values in Liquid / Storefront API.
//
// Purely band+cup product types (bustier, chemise, dress) are intentionally NOT
// separate categories: the theme pre-selects those from the saved bra band+cup.
// bodysuit IS a category because many are letter-sized (e.g. Onyx Bodysuit,
// XXS-XXL); band+cup bodysuits still fall back to the saved bra size on the theme.
//
// Registered in app/lib/metafieldDefinitions.server.js and surfaced on the
// Metafield definitions admin page. Pairs with the write route
// app/routes/api.size-preference.jsx and the CA UI extension.

export const SIZE_PREFERENCE_GROUP = {
  id: "size-preference",
  title: "Size preference",
  description:
    "Customer size profile (bra band + cup, thong, brief, suspender, corset, skirt, swimsuit, top, bodysuit, hosiery, robe, latex). Read by the account extension and the theme for quick-add / PDP pre-select.",
  ownerType: "CUSTOMER",
  namespace: "size_preference",
  // `choices` validations enforce the allowed AU sizes and give merchants a
  // dropdown when editing the customer in admin.
  definitions: [
    {
      key: "band",
      name: "Size preference - Bra band",
      description: "Customer's saved bra band size (AU).",
      type: "single_line_text_field",
      choices: ["8", "10", "12", "14", "16"],
    },
    {
      key: "cup",
      name: "Size preference - Bra cup",
      description: "Customer's saved bra cup size (AU).",
      type: "single_line_text_field",
      choices: ["A", "B", "C", "D", "DD", "E", "F", "G"],
    },
    {
      key: "thong",
      name: "Size preference - Thong",
      description: "Customer's saved thong size (AU).",
      type: "single_line_text_field",
      choices: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "brief",
      name: "Size preference - Brief",
      description: "Customer's saved brief size (AU).",
      type: "single_line_text_field",
      choices: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "suspender",
      name: "Size preference - Suspender",
      description: "Customer's saved suspender size (AU).",
      type: "single_line_text_field",
      choices: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "corset",
      name: "Size preference - Corset",
      description: "Customer's saved corset size (AU).",
      type: "single_line_text_field",
      choices: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "skirt",
      name: "Size preference - Skirt",
      description: "Customer's saved skirt size (AU).",
      type: "single_line_text_field",
      choices: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "swimsuit",
      name: "Size preference - Swimsuit",
      description: "Customer's saved swimsuit size (AU).",
      type: "single_line_text_field",
      choices: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "top",
      name: "Size preference - Top",
      description: "Customer's saved top size (AU).",
      type: "single_line_text_field",
      choices: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "bodysuit",
      name: "Size preference - Bodysuit",
      description: "Customer's saved bodysuit size (AU). Letter-sized bodysuits only; band+cup bodysuits use the saved bra size.",
      type: "single_line_text_field",
      choices: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
    },
    {
      key: "hosiery",
      name: "Size preference - Hosiery",
      description: "Customer's saved hosiery size (AU).",
      type: "single_line_text_field",
      choices: ["S", "M", "L"],
    },
    {
      key: "robe",
      name: "Size preference - Robe",
      description: "Customer's saved robe size (AU).",
      type: "single_line_text_field",
      choices: ["S/M", "M/L"],
    },
    {
      key: "latex",
      name: "Size preference - Latex",
      description: "Customer's saved latex size (AU).",
      type: "single_line_text_field",
      choices: ["S/M", "M/L"],
    },
  ],
};
