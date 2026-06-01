// Thin client for the Kibo Commerce OMS REST API.
//
// The app spans 4 regions (AU, US, UK, EU), each a separate Shopify store with
// its OWN Kibo instance/credentials. So Kibo config is resolved PER SHOP, not
// globally. All regions live in a single JSON env var keyed by myshopify domain:
//
//   KIBO_REGIONS = {
//     "amd-checkout-2024.myshopify.com": {
//       "authHost": "https://home.mozu.com",
//       "apiHost":  "https://t1234.tp1.mozu.com",
//       "clientId": "...", "clientSecret": "...",
//       "tenantId": "1234", "siteId": "5678"
//     },
//     "honeybirdette-us.myshopify.com": { ... },
//     ...
//   }
//
// A region is "configured" when its entry has all six fields. Until then the
// Kibo Checker page for that store shows "not configured" and is disabled.
//
// NOTE: exact host paths, the connector's externalId convention, and the full
// createOrder payload must be confirmed against each Kibo sandbox (see the
// plan's "Open items"). Everything Kibo-specific is isolated in this file.

const REQUIRED_FIELDS = [
  "authHost",
  "apiHost",
  "clientId",
  "clientSecret",
  "tenantId",
  "siteId",
];

let parsedRegions = null;
let parsedRaw = null;

function regions() {
  const raw = process.env.KIBO_REGIONS || "";
  if (raw === parsedRaw) return parsedRegions || {};
  parsedRaw = raw;
  try {
    parsedRegions = raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("[kibo] KIBO_REGIONS is not valid JSON:", err?.message);
    parsedRegions = {};
  }
  return parsedRegions;
}

// myshopify domains that have an entry in KIBO_REGIONS (configured or not).
export function listRegionShops() {
  return Object.keys(regions());
}

// myshopify domains whose entry is fully configured.
export function listConfiguredShops() {
  return listRegionShops().filter((shop) => isConfigured(shop));
}

export function missingEnv(shop) {
  const entry = regions()[shop];
  if (!entry) return [`KIBO_REGIONS has no entry for ${shop}`];
  return REQUIRED_FIELDS.filter((f) => !entry[f]);
}

export function isConfigured(shop) {
  const entry = regions()[shop];
  return !!entry && REQUIRED_FIELDS.every((f) => !!entry[f]);
}

function cfg(shop) {
  if (!isConfigured(shop)) {
    throw new Error(
      `Kibo is not configured for ${shop} - ${missingEnv(shop).join(", ")}`,
    );
  }
  const e = regions()[shop];
  return {
    authHost: e.authHost.replace(/\/$/, ""),
    apiHost: e.apiHost.replace(/\/$/, ""),
    clientId: e.clientId,
    clientSecret: e.clientSecret,
    tenantId: String(e.tenantId),
    siteId: String(e.siteId),
  };
}

// --- OAuth token cache, keyed per shop (each region authenticates separately).
const tokenCache = new Map(); // shop -> { token, expiresAt }

async function getToken(shop) {
  const c = cfg(shop);
  const cached = tokenCache.get(shop);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const res = await fetch(`${c.authHost}/api/platform/applications/authtickets/oauth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Kibo auth failed for ${shop}: ${res.status} ${await safeText(res)}`);
  }
  const body = await res.json();
  const token = body.access_token || body.accessToken;
  const ttlMs = (body.expires_in ?? 3600) * 1000;
  tokenCache.set(shop, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function kiboFetch(shop, path, { method = "GET", body } = {}) {
  const c = cfg(shop);
  const token = await getToken(shop);
  const res = await fetch(`${c.apiHost}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-vol-tenant": c.tenantId,
      "x-vol-site": c.siteId,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`Kibo ${method} ${path} (${shop}) -> ${res.status} ${await safeText(res)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Look an order up in this shop's Kibo. quickSearch matches externalId AND order
// number / email, so we pass whatever identifiers we have and confirm the match.
// Returns the Kibo order id, or null if not present.
export async function findOrderByExternalId(shop, { externalId, orderName }) {
  const term = encodeURIComponent(externalId || orderName || "");
  if (!term) return null;
  const data = await kiboFetch(shop, `/commerce/orders?quickSearch=${term}&pageSize=5`);
  const items = data?.items || [];
  if (!items.length) return null;
  const exact = items.find(
    (o) =>
      (externalId && String(o.externalId) === String(externalId)) ||
      (orderName && String(o.externalId) === String(orderName)),
  );
  const match = exact || items[0];
  return match?.id || match?.orderNumber?.toString() || null;
}

// Create (import) an order in this shop's Kibo. isImport=true tells Kibo to
// accept it as an import rather than running new-order processing.
export async function createOrder(shop, payload) {
  const data = await kiboFetch(shop, `/commerce/orders?isImport=true`, {
    method: "POST",
    body: payload,
  });
  return data?.id || data?.orderNumber?.toString() || null;
}

// Exposed for tests / manual reset.
export function _resetTokenCache() {
  tokenCache.clear();
}
