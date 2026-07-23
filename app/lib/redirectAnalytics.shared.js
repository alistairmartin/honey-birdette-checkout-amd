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

// ---------------------------------------------------------------------------
// Region catchment - transcribed from the live `regionalisation-v2` section
// blocks in the theme settings. Each block is one region: a currency, a
// destination store (derived from region_url) and the countries it covers.
//
// Keep `countries` byte-for-byte as the theme's `other_countries` string so the
// two can be diffed by eye. Source of truth is the theme; update here when a
// merchant edits it there.
// ---------------------------------------------------------------------------

// region_url -> canonical store code.
const STORE_BY_URL = {
  "www.honeybirdette.com": "AU",
  "us.honeybirdette.com": "US",
  "eu.honeybirdette.com": "EU",
  "uk.honeybirdette.com": "UK",
};

const REGION_BLOCKS = [
  {
    region: "AU", currency: "AUD", url: "www.honeybirdette.com", title: "Australia",
    countries:
      "AF,BD,BN,BT,CC,CN,CX,HK,ID,IN,JP,KG,KH,KP,KR,KZ,LA,LK,MM,MN,MO,MV,MY,NF,NP,PH,PK,SG,TH,TJ,TL,TM,TW,UZ,VN, FJ, KI, FM, MH, NR, PW, PG, SB, TO, TV, VU, WS, NC, PF, WF, PN, AU",
  },
  {
    region: "NZ", currency: "NZD", url: "www.honeybirdette.com", title: "New Zealand",
    countries: "NZ,",
  },
  {
    region: "US", currency: "USD", url: "us.honeybirdette.com", title: "United States",
    countries:
      "AG,AI,AR,AS,AW,BB,BL,BM,BO,BQ,BR,BS,BZ,CL,CO,CR,CU,CW,DM,DO,EC,FK,GD,GF,GL,GP,GT,GU,GY,HN,HT,JM,KN,KY,LC,MF,MP,MQ,MS,MX,NI,PA,PE,PM,PR,PY,SR,SV,SX,TC,TT,UM,UY,VC,VE,VG,VI, US",
  },
  {
    region: "CA", currency: "CAD", url: "us.honeybirdette.com", title: "Canada",
    countries: "CA,",
  },
  {
    region: "EU", currency: "EUR", url: "eu.honeybirdette.com", title: "Europe",
    countries:
      "AD,AL,AM,AO,AT,AX,AZ,BA,BE,BF,BG,BH,BI,BJ,BW,BY,CD,CF,CG,CH,CI,CM,CV,CY,CZ,DJ,DK,DZ,EE,EG,EH,ER,ES,ET,FI,FO,GA,GE,GH,GM,GN,GQ,GR,GW,HR,HU,IE,IL,IQ,IR,IS,IT,JO,KE,KM,KW,LB,LI,LR,LS,LT,LU,LV,LY,MA,MC,MD,ME,MG,MK,ML,MR,MT,MU,MW,MZ,NA,NE,NG,NL,NO,OM,PL,PS,PT,QA,RE,RO,RS,RU,RW,SA,SC,SD,SE,SH,SI,SJ,SK,SL,SM,SN,SO,SS,ST,SY,SZ,TD,TG,TN,TR,TZ,UA,UG,VA,XK,YE,YT,ZA,ZM,ZW",
  },
  {
    region: "DE", currency: "EUR", url: "eu.honeybirdette.com", title: "Germany",
    countries: "DE,", language: "German", path: "/de",
  },
  {
    region: "FR", currency: "EUR", url: "eu.honeybirdette.com", title: "France",
    countries: "FR,", language: "French", path: "/fr",
  },
  {
    region: "AE", currency: "AED", url: "eu.honeybirdette.com", title: "United Arab Emirates",
    countries: "AE,",
  },
  {
    region: "GB", currency: "GBP", url: "uk.honeybirdette.com", title: "United Kingdom",
    countries: "GG,GI,IM,JE,GB,GB",
  },
];

// The theme's lists carry stray spaces, trailing commas and duplicates.
function parseCountries(csv) {
  return [...new Set(
    String(csv || "")
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter((c) => /^[a-z]{2}$/.test(c)),
  )];
}

// The single country painted red as the redirect source. The EU store reports
// itself as NL (`store_region: "NL"`), which is why NL is its home marker.
const STORE_HOME_ISO = { AU: "au", US: "us", UK: "gb", EU: "nl" };

// Build, per store, the region groups it serves.
const CATCHMENT = (() => {
  const out = {};
  for (const b of REGION_BLOCKS) {
    const store = STORE_BY_URL[b.url];
    if (!store) continue;
    (out[store] ||= { store, home: STORE_HOME_ISO[store], groups: [] }).groups.push({
      region: b.region,
      title: b.title,
      currency: b.currency,
      language: b.language || null,
      path: b.path || null,
      iso: parseCountries(b.countries),
    });
  }
  // Primary (largest) group first so the legend reads main-currency-first.
  for (const s of Object.values(out)) {
    s.groups.sort((a, b) => b.iso.length - a.iso.length);
    s.currency = s.groups[0]?.currency;
  }
  return out;
})();

export function catchmentFor(storeCode) {
  return CATCHMENT[canonicalStore(storeCode)] || null;
}

// The store's own country - painted red as the redirect source.
export function sourceIsoFor(storeCode) {
  const home = catchmentFor(storeCode)?.home;
  return home ? [home] : [];
}

// Outline colours for catchment groups: orange, aqua, violet, yellow. Distinct
// from the blue data ramp and the red source, so an overlay never reads as a
// value. Order is fixed, never cycled.
const GROUP_COLORS = ["#eb6834", "#1baf7a", "#4a3aa7", "#eda100"];

// Map overlays for a selected store: one entry per region group.
export function overlaysFor(storeCode) {
  const c = catchmentFor(storeCode);
  if (!c) return [];
  return c.groups.map((g, i) => ({
    iso: g.iso,
    color: GROUP_COLORS[i % GROUP_COLORS.length],
    label: g.language
      ? `${g.title} - ${g.language} (${g.path})`
      : `${g.title} - ${g.currency} (${g.iso.length} ${g.iso.length === 1 ? "country" : "countries"})`,
  }));
}

// Plain-English summary of what the store covers, for the caption.
export function catchmentSummary(storeCode) {
  const c = catchmentFor(storeCode);
  if (!c) return "";
  return c.groups
    .map((g) =>
      g.language
        ? `${g.title} in ${g.language} (${g.path})`
        : `${g.title} in ${g.currency}`,
    )
    .join(", ");
}
