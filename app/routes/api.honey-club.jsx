import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  findOmneoProfile,
  getOmneoBalances,
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

// Shape Omneo's TierProgress + balances into exactly what the cards render.
// Amounts are in the store's currency (Omneo `next_remain` is dollars; the
// theme's cart loyalty message formats it the same way).
function toStatus(progress, balances, currency) {
  const tier = progress?.current_tier;
  if (!tier?.name) return { member: false, currency };

  const nextTier = progress.next_tier;
  const rawProgress = toNumber(progress.next_progress);

  return {
    member: true,
    currency,
    tier: { name: tier.name, handle: tier.handle ?? null },
    nextTier: nextTier?.name ? { name: nextTier.name, handle: nextTier.handle ?? null } : null,
    spent: toNumber(progress.total_points_12m) ?? 0,
    remaining: toNumber(progress.next_remain),
    progress: rawProgress === null ? null : Math.max(0, Math.min(100, rawProgress)),
    maintainedUntil: tier.anniversary_at || progress.anniversary_at || null,
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

    const [progress, balances] = await Promise.all([
      getOmneoTierProgress(profile.id),
      getOmneoBalances(profile.id).catch((err) => {
        // A missing balance shouldn't hide the tier card; hide just the balance.
        console.error("honey-club balances failed", err);
        return null;
      }),
    ]);

    return cors(json(toStatus(progress, balances, currency)));
  } catch (err) {
    console.error("honey-club read failed", err);
    return cors(json({ error: "Failed to load Honey Club status" }, { status: 502 }));
  }
};
