// Pure constants + helpers shared between the client route component and the
// server module. Kept out of `*.server.js` so Remix can include them in the
// client bundle without tripping the "server-only module" guard.

export const SUPPORTED_CURRENCIES = ["AUD", "USD", "GBP", "EUR"];

export const DEFAULT_THRESHOLDS = {
  AUD: 250,
  USD: 300,
  GBP: 200,
  EUR: 250,
};

export const DEFAULT_PERCENTAGE = 50;
export const WEEK_COUNT = 5;

const emptyWeek = () => ({productId: "", title: "", note: ""});

export function defaultSchedule() {
  return {
    discountPercentage: DEFAULT_PERCENTAGE,
    thresholds: {...DEFAULT_THRESHOLDS},
    activeWeek: null,
    enabled: true,
    weeks: Array.from({length: WEEK_COUNT}, (_, i) => ({
      ...emptyWeek(),
      week: i + 1,
    })),
  };
}

export function toProductGid(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (str.startsWith("gid://shopify/Product/")) return str;
  const numeric = str.replace(/[^0-9]/g, "");
  return numeric ? `gid://shopify/Product/${numeric}` : null;
}
