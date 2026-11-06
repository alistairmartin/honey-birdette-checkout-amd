// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-10 API).
//
// "Exclusive gifts": tier-gated gift offers with "Show in customer account"
// ticked in the app (Gift With Purchase with Honey Club tiers eligibility, or
// Loyalty > Exclusives). The backend (/api/account-gifts) already filters to
// offers this customer's tier qualifies for and hasn't redeemed, so this only
// renders. Shows nothing at all when there are no gifts.
import { useEffect, useState } from "preact/hooks";

const API_URL = "https://honey-birdette-checkout-amd.onrender.com";

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

function money(amount, currency) {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return shopify.i18n.formatCurrency(amount, {
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// `storefrontUrl` comes from the page so relative links resolve per store.
export function ExclusiveGifts({ storefrontUrl }) {
  const [gifts, setGifts] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = await shopify.sessionToken.get();
        const resp = await fetch(`${API_URL}/api/account-gifts`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
        const data = await resp.json();
        if (!cancelled) setGifts(Array.isArray(data.gifts) ? data.gifts : []);
      } catch (e) {
        console.error("HoneyClubPage: failed to load exclusive gifts", e);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!gifts.length) return null;

  return (
    <s-section heading={t("giftsHeading")}>
      <s-stack gap="base">
        {gifts.map((gift) => {
          const heading = gift.heading || gift.giftTitle || t("giftFallbackHeading");
          const message =
            gift.message ||
            (gift.minSpend
              ? t("giftMinSpend", { amount: money(gift.minSpend, gift.currency) })
              : t("giftGeneric"));
          const rawUrl = gift.ctaUrl || "/";
          const href = rawUrl.startsWith("/") ? storefrontUrl(rawUrl) : rawUrl;
          return (
            <s-query-container key={gift.id}>
              <s-grid
                gridTemplateColumns="@container (inline-size > 500px) 160px 1fr, 1fr"
                gap="base"
                alignItems="center"
              >
                {gift.image ? (
                  <s-image src={gift.image} alt={heading} aspectRatio="1" objectFit="cover" borderRadius="base" />
                ) : null}
                <s-stack gap="small-300">
                  <s-text color="subdued">{t("giftEyebrow", { tier: gift.tier })}</s-text>
                  <s-heading>{heading}</s-heading>
                  <s-paragraph>{message}</s-paragraph>
                  <s-button href={href} variant="primary">
                    {gift.ctaText || t("giftCta")}
                  </s-button>
                </s-stack>
              </s-grid>
            </s-query-container>
          );
        })}
      </s-stack>
    </s-section>
  );
}
