// Store-code helpers shared by the server aggregation and the browser dashboard.

// The storefront writes `_hb_redirect_from` from GM_STATE.shopify.storeRegion,
// falling back to the section's region setting - and the two disagree for two
// stores: the UK store reports GB or UK, the EU store reports NL or EU. The
// destination side has the same split, because a store's region is derived from
// its selling currency (GBP -> GB, EUR -> EU). Fold both onto one canonical
// store code so a single store is never split across two buckets.
//
// Only ever applied to STORE codes. `_detected_country` keeps its real ISO code,
// since GB and NL are genuine countries that must stay distinct on the map.
const STORE_ALIASES = { GB: "UK", NL: "EU" };

export function canonicalStore(code) {
  if (!code) return code;
  return STORE_ALIASES[String(code).toUpperCase()] || String(code).toUpperCase();
}

export const STORE_LABEL = {
  AU: "Australia (AU)",
  UK: "United Kingdom (UK)",
  EU: "Europe (EU)",
  US: "United States (US)",
  NZ: "New Zealand (NZ)",
  CA: "Canada (CA)",
};

export function storeLabel(code) {
  return STORE_LABEL[code] || code;
}

// The country (or countries) a store physically sells from, used to paint the
// source store red on the map. EU is a region, so it highlights the member
// states the EU store serves.
export const STORE_SOURCE_ISO = {
  AU: ["au"],
  UK: ["gb"],
  US: ["us"],
  EU: [
    "at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr",
    "hu", "ie", "it", "lv", "lt", "lu", "mt", "nl", "pl", "pt", "ro", "sk",
    "si", "es", "se",
  ],
};

export function sourceIsoFor(storeCode) {
  return STORE_SOURCE_ISO[canonicalStore(storeCode)] || [];
}
