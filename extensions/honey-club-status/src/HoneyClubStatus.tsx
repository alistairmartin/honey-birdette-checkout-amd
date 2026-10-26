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

// The AMD Checkout app backend (Render). Same for every store.
const API_URL = "https://honey-birdette-checkout-amd.onrender.com";

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

function setting(key) {
  const value = shopify.settings?.value?.[key];
  return typeof value === "string" ? value.trim() : "";
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

// Editor-only preview data, so both states can be checked in the customer
// account editor (its preview customer isn't in Omneo, so live data is always
// the Join card there).
const PREVIEW_MEMBER = {
  member: true,
  currency: "AUD",
  tier: { name: "Gold AU", handle: "gold-au" },
  nextTier: { name: "Platinum AU", handle: "platinum-au" },
  spent: 0,
  remaining: 500,
  progress: 6,
  maintainedUntil: "2027-09-01",
  balance: 0,
};
const PREVIEW_JOIN = { member: false, currency: "AUD" };

const PREVIEW_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "join", label: "Non-member" },
  { value: "live", label: "Live data" },
];

// Only rendered when shopify.extension.editor is set, i.e. never for customers.
function PreviewSwitcher({ value, onChange }) {
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      <s-text type="small" color="subdued">Editor preview:</s-text>
      {PREVIEW_OPTIONS.map((option) => (
        <s-button
          key={option.value}
          variant={value === option.value ? "primary" : "secondary"}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </s-button>
      ))}
    </s-stack>
  );
}

function HoneyClubStatus() {
  // undefined = loading, null = failed (render nothing), object = loaded.
  const [liveStatus, setStatus] = useState(undefined);
  const inEditor = Boolean(shopify.extension?.editor);
  const [preview, setPreview] = useState("member");
  const [firstName, setFirstName] = useState("");

  // "Hello, Sophia" greeting: first name from the Customer Account API.
  useEffect(() => {
    if (shopify.settings?.value?.hide_greeting) return;
    shopify
      .query(`query { customer { firstName } }`)
      .then((result) => setFirstName(result?.data?.customer?.firstName?.trim() || ""))
      .catch((e) => console.error("HoneyClubStatus: failed to load name", e));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = await shopify.sessionToken.get();
        const resp = await fetch(`${API_URL}/api/honey-club`, {
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

  const previewing = inEditor && preview !== "live";
  const status = previewing
    ? preview === "member"
      ? PREVIEW_MEMBER
      : PREVIEW_JOIN
    : liveStatus;
  const switcher = inEditor && <PreviewSwitcher value={preview} onChange={setPreview} />;

  if (status === undefined) {
    return (
      <s-section heading={t("levelTitle")}>
        <s-skeleton-paragraph />
      </s-section>
    );
  }

  // On a backend/Omneo failure, show nothing: guessing would risk telling a
  // member to "Join the club".
  if (status === null) return switcher || null;

  return (
    <s-stack gap="base">
      {switcher}
      {firstName && <s-heading>{t("greeting", { name: firstName })}</s-heading>}
      {status.member ? (
        <>
          <LevelCard status={status} />
          {status.balance !== null && <BalanceCard status={status} />}
        </>
      ) : (
        <JoinCard />
      )}
    </s-stack>
  );
}

// "Gold AU" -> "Gold" for the sentence; the badge keeps the full tier name.
function shortTierName(name) {
  return name.replace(/\s+[A-Z]{2}$/, "") || name;
}

// Two subdued texts on one line, pushed to opposite edges.
function SplitRow({ left, right }) {
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
      <s-text color="subdued">{left}</s-text>
      {right && <s-text color="subdued">{right}</s-text>}
    </s-stack>
  );
}

function LevelCard({ status }) {
  const { tier, nextTier, currency, spent, remaining, progress, maintainedUntil } = status;
  const until = maintainedUntil ? formatDate(maintainedUntil) : "";
  const spentText = t("spentThisYear", { amount: money(spent, currency) });

  // Design: heading + badge / progress bar / spent left, to-next right / maintained.
  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
          <s-heading>{t("levelTitle")}</s-heading>
          <s-badge>{tier.name}</s-badge>
        </s-stack>

        {nextTier ? (
          <>
            {progress !== null && (
              <s-progress
                value={progress}
                max={100}
                accessibilityLabel={t("progressLabel", { tier: nextTier.name })}
              />
            )}
            <SplitRow
              left={spentText}
              right={
                remaining !== null
                  ? t("toNextTier", { amount: money(remaining, currency), tier: nextTier.name })
                  : ""
              }
            />
          </>
        ) : (
          <>
            <s-progress value={100} max={100} accessibilityLabel={t("topTier")} />
            <SplitRow left={spentText} right={t("topTier")} />
          </>
        )}

        {until && (
          <s-text color="subdued">
            {t("maintainedUntil", { tier: shortTierName(tier.name), date: until })}
          </s-text>
        )}
      </s-stack>
    </s-section>
  );
}

// Design: heading left, amount right / note.
function BalanceCard({ status }) {
  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
          <s-heading>{t("balanceTitle")}</s-heading>
          <s-heading>{money(status.balance, status.currency)}</s-heading>
        </s-stack>
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
    setting("join_benefit_3") || t("joinBenefit3"),
  ].filter(Boolean);

  const content = (
    <s-stack gap="base">
      <s-text color="subdued">{setting("join_eyebrow") || t("eyebrow")}</s-text>
      <s-heading>{setting("join_heading") || t("joinHeading")}</s-heading>
      {setting("join_body") && <s-paragraph>{setting("join_body")}</s-paragraph>}
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
