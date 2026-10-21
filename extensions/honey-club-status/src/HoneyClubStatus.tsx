// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-07 API). No React / @shopify/ui-extensions-react.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// The target is bound in shopify.extension.toml
// (customer-account.profile.block.render -> this module).
export default async () => {
  render(<HoneyClubStatus />, document.body);
};

const DEFAULT_API_URL = "https://honey-birdette-checkout-amd.onrender.com";

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

function setting(key) {
  const value = shopify.settings?.value?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function apiBase() {
  return (setting("api_url") || DEFAULT_API_URL).replace(/\/+$/, "");
}

function money(amount, currency) {
  return shopify.i18n.formatCurrency(amount, {
    currency,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  });
}

// "01 Sep 2027", per the design.
function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return shopify.i18n.formatDate(date, { day: "2-digit", month: "short", year: "numeric" });
}

function HoneyClubStatus() {
  // undefined = loading, null = failed (render nothing), object = loaded.
  const [status, setStatus] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = await shopify.sessionToken.get();
        const resp = await fetch(`${apiBase()}/api/honey-club`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
        const data = await resp.json();
        if (!cancelled) setStatus(data);
      } catch (e) {
        console.error("HoneyClubStatus: failed to load", e);
        if (!cancelled) setStatus(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === undefined) {
    return (
      <s-section heading={t("levelTitle")}>
        <s-skeleton-paragraph />
      </s-section>
    );
  }

  // On a backend/Omneo failure, show nothing: guessing would risk telling a
  // member to "Join the club".
  if (status === null) return null;

  if (!status.member) return <JoinCard />;

  return (
    <s-query-container>
      <s-grid gridTemplateColumns="@container (inline-size > 600px) 2fr 1fr, 1fr" gap="base">
        <LevelCard status={status} />
        <BalanceCard status={status} />
      </s-grid>
    </s-query-container>
  );
}

function LevelCard({ status }) {
  const { tier, nextTier, currency, spent, remaining, progress, maintainedUntil } = status;
  const until = maintainedUntil ? formatDate(maintainedUntil) : "";

  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
          <s-heading>{t("levelTitle")}</s-heading>
          <s-badge>{tier.name}</s-badge>
        </s-stack>

        <s-text>{t("spentThisYear", { amount: money(spent, currency) })}</s-text>

        {nextTier ? (
          <s-stack gap="small-300">
            {progress !== null && (
              <s-progress
                value={progress}
                max={100}
                accessibilityLabel={t("progressLabel", { tier: nextTier.name })}
              />
            )}
            {remaining !== null && (
              <s-text color="subdued">
                {t("toNextTier", { amount: money(remaining, currency), tier: nextTier.name })}
              </s-text>
            )}
          </s-stack>
        ) : (
          <s-text color="subdued">{t("topTier")}</s-text>
        )}

        {until && (
          <s-text type="small" color="subdued">
            {t("maintainedUntil", { tier: tier.name, date: until })}
          </s-text>
        )}
      </s-stack>
    </s-section>
  );
}

function BalanceCard({ status }) {
  return (
    <s-section>
      <s-stack gap="base">
        <s-heading>{t("balanceTitle")}</s-heading>
        <s-text type="strong">{money(status.balance, status.currency)}</s-text>
        <s-text color="subdued">{t("balanceNote")}</s-text>
      </s-stack>
    </s-section>
  );
}

// "Birthday treat. $25 voucher*" -> bold "Birthday treat." + the rest.
function Benefit({ text }) {
  const split = text.indexOf(". ");
  if (split === -1) return <s-list-item>{text}</s-list-item>;
  return (
    <s-list-item>
      <s-text type="strong">{text.slice(0, split + 1)}</s-text> {text.slice(split + 2)}
    </s-list-item>
  );
}

function JoinCard() {
  const imageUrl = setting("join_image_url");
  const ctaUrl = setting("join_cta_url");
  const benefits = [
    setting("join_benefit_1") || t("joinBenefit1"),
    setting("join_benefit_2") || t("joinBenefit2"),
    setting("join_benefit_3"),
  ].filter(Boolean);

  const content = (
    <s-stack gap="base">
      <s-text color="subdued">{t("eyebrow")}</s-text>
      <s-heading>{setting("join_heading") || t("joinHeading")}</s-heading>
      <s-paragraph>{setting("join_body") || t("joinBody")}</s-paragraph>
      <s-unordered-list>
        {benefits.map((b) => (
          <Benefit key={b} text={b} />
        ))}
      </s-unordered-list>
      {ctaUrl && (
        <s-button variant="primary" href={ctaUrl}>
          {setting("join_cta_text") || t("joinCta")}
        </s-button>
      )}
    </s-stack>
  );

  if (!imageUrl) return <s-section>{content}</s-section>;

  return (
    <s-section>
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 600px) 1fr 1fr, 1fr"
          gap="large-100"
          alignItems="center"
        >
          <s-image src={imageUrl} alt="" aspectRatio="1" objectFit="cover" borderRadius="base" />
          {content}
        </s-grid>
      </s-query-container>
    </s-section>
  );
}
