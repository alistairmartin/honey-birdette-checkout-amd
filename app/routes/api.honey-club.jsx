import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  findOmneoProfile,
  getOmneoBalances,
  getOmneoTierDefinitions,
  getOmneoTierProgress,
  omneoConfigured,
  omneoShopConfig,
} from "../lib/omneo.server";

// Backs the "honey-club-status" customer-account UI extension: the Honey Club
// level card (tier, spend, progress to next tier), the balance card, and the
// "Join the club" card for non-members. Read-only.
//
// Auth: authenticate.public.customerAccount verifies the extension's signed
// session token, so the customer and shop come from the JWT (`sub` / `dest`),
// never from the request. Same pattern as api.size-preference.jsx.

function numericCustomerId(sub) {
  return String(sub || "").replace(/[^0-9]/g, "");
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Omneo dates are "2027-07-24 13:59:59" in UTC. Safari can't parse that form,
// so hand the extension ISO 8601 instead.
function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The customer's region's tiers, lowest first, each marked achieved / current /
// locked relative to their current tier. Empty if definitions are unavailable.
function tierLadder(definitions, currentTier) {
  const current = toNumber(currentTier.value_min) ?? 0;
  return definitions
    .filter((t) => t?.name && t.region_id === currentTier.region_id)
    .map((t) => ({ name: t.name, handle: t.handle ?? null, min: toNumber(t.value_min) ?? 0 }))
    .sort((a, b) => a.min - b.min)
    .map((t) => ({
      ...t,
      status: t.handle === currentTier.handle ? "current" : t.min < current ? "achieved" : "locked",
    }));
}

// Shape Omneo's TierProgress + balances into exactly what the cards render.
// Amounts are in the store's currency: Omneo's `next_progress`, `next_remain`
// and `current_remain` are dollars (verified live 2026-10-26: 300 spent,
// 200 remaining to Diamond at 500), not percentages.
function toStatus(progress, balances, definitions, currency) {
  const tier = progress?.current_tier;
  if (!tier?.name) return { member: false, currency };

  const nextTier = progress.next_tier;
  const nextMin = toNumber(nextTier?.value_min);
  const towardNext = toNumber(progress.next_progress);
  const percent =
    nextMin && towardNext !== null ? Math.max(0, Math.min(100, (towardNext / nextMin) * 100)) : null;

  return {
    member: true,
    currency,
    tier: { name: tier.name, handle: tier.handle ?? null },
    nextTier: nextTier?.name
      ? { name: nextTier.name, handle: nextTier.handle ?? null, min: nextMin }
      : null,
    tiers: tierLadder(definitions, tier),
    spent: toNumber(progress.total_points_12m) ?? 0,
    remaining: toNumber(progress.next_remain),
    progress: percent === null ? null : Math.round(percent),
    // Spend still needed this period to keep the current tier, and by when.
    maintainRemaining: toNumber(progress.current_remain),
    maintainedUntil: toIsoDate(progress.anniversary_at),
    // null = balances unavailable (e.g. token lacks scope); the card is hidden.
    balance: balances ? toNumber(balances.combined_balance_dollars) ?? 0 : null,
  };
}

// authenticate.public.customerAccount handles the CORS preflight and headers.
export const loader = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const customerId = numericCustomerId(sessionToken?.sub);
  const shop = String(sessionToken?.dest || "").replace(/^https?:\/\//, "");
  if (!customerId || !shop) {
    return cors(json({ error: "Unauthenticated" }, { status: 401 }));
  }
  if (!omneoConfigured()) {
    return cors(json({ error: "Omneo not configured" }, { status: 503 }));
  }

  // Unknown shops (e.g. the dev store) still resolve via any shopify-* identity.
  const currency = omneoShopConfig(shop)?.currency ?? "AUD";

  try {
    const profile = await findOmneoProfile(shop, customerId);
    if (!profile) return cors(json({ member: false, currency }));

    const [progress, balances, definitions] = await Promise.all([
      getOmneoTierProgress(profile.id),
      getOmneoBalances(profile.id).catch((err) => {
        // A missing balance shouldn't hide the tier card; hide just the balance.
        console.error("honey-club balances failed", err);
        return null;
      }),
      getOmneoTierDefinitions().catch((err) => {
        // Without definitions the card still shows current -> next tier.
        console.error("honey-club tier definitions failed", err);
        return [];
      }),
    ]);

    return cors(json(toStatus(progress, balances, definitions, currency)));
  } catch (err) {
    console.error("honey-club read failed", err);
    return cors(json({ error: "Failed to load Honey Club status" }, { status: 502 }));
  }
};
