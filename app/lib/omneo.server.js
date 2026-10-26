// Minimal Omneo client for the customer-account extensions.
//
// HB runs one Omneo tenant (`honeybirdette`) across all four regional stores.
// Endpoint paths and field names are verified against @omneo/omneo-sdk (as used
// by the Honey List app) and the birthday-widget backend:
//   GET /identities/search-profile/{shopifyCustomerId} -> { data: Profile[] }
//   GET /profiles/{id}/tiers                           -> { data: TierProgress }
//   GET /profiles/{id}/balances                        -> { data: ProfileBalances }
//   GET /profiles/{id}/transactions                    -> { data: Transaction[], meta }
//
// Env: OMNEO_API_TOKEN, one read-only token for every Omneo call (identities,
// profiles, tiers, loyalty, transactions, lists). OMNEO_TENANT / OMNEO_API_BASE
// override the defaults.

const OMNEO_TENANT = process.env.OMNEO_TENANT || "honeybirdette";
const OMNEO_API_BASE =
  process.env.OMNEO_API_BASE || `https://api.${OMNEO_TENANT}.getomneo.com/api/v3`;

// Omneo identity handle + currency for each store. The US store is referred to
// by both handles across this repo, so map both.
const SHOPS = {
  "honey-birdette-2.myshopify.com": { identity: "shopify-au", currency: "AUD" },
  "honey-birdette-uk.myshopify.com": { identity: "shopify-uk", currency: "GBP" },
  "honey-birdette-eu.myshopify.com": { identity: "shopify-eu", currency: "EUR" },
  "honey-birdette-usa.myshopify.com": { identity: "shopify-us", currency: "USD" },
  "honeybirdette-us.myshopify.com": { identity: "shopify-us", currency: "USD" },
};

export function omneoShopConfig(shop) {
  return SHOPS[shop] ?? null;
}

export function omneoConfigured() {
  return !!process.env.OMNEO_API_TOKEN;
}

async function omneoRequest(path) {
  const response = await fetch(`${OMNEO_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.OMNEO_API_TOKEN}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Omneo ${path} failed: ${response.status} ${body}`.trim());
  }
  return response.json();
}

// Find the Omneo profile linked to a Shopify customer. Prefer the store's own
// identity handle, then fall back to any shopify-* identity (one tenant serves
// every region, so a customer may only be linked via another store).
export async function findOmneoProfile(shop, customerId) {
  const handle = omneoShopConfig(shop)?.identity;
  const result = await omneoRequest(
    `/identities/search-profile/${encodeURIComponent(customerId)}`,
  );
  const profiles = Array.isArray(result?.data) ? result.data : [];

  const matches = (profile, matchHandle) =>
    (profile.identities || []).some(
      (identity) =>
        identity.is_active !== false &&
        String(identity.identifier) === String(customerId) &&
        (matchHandle
          ? identity.handle === matchHandle
          : String(identity.handle || "").toLowerCase().startsWith("shopify")),
    );

  return (
    (handle && profiles.find((p) => matches(p, handle))) ||
    profiles.find((p) => matches(p, null)) ||
    null
  );
}

export async function getOmneoTierProgress(profileId) {
  const result = await omneoRequest(`/profiles/${encodeURIComponent(profileId)}/tiers`);
  return result?.data ?? null;
}

export async function getOmneoBalances(profileId) {
  const result = await omneoRequest(`/profiles/${encodeURIComponent(profileId)}/balances`);
  return result?.data ?? null;
}

// One page of a profile's transactions (retail POS + online), newest first.
// Returns Omneo's paginated envelope: { data: Transaction[], meta, links }.
export async function getOmneoTransactions(profileId, { page = 1, pageSize = 10 } = {}) {
  const params = new URLSearchParams({
    "page[number]": String(page),
    "page[size]": String(pageSize),
    sort: "-transacted_at",
    include: "product",
  });
  return omneoRequest(`/profiles/${encodeURIComponent(profileId)}/transactions?${params}`);
}
