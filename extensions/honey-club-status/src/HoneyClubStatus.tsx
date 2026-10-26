// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-07 API). No React / @shopify/ui-extensions-react.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { BirthdayCard } from "./Birthday";

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

// Whole amounts drop the cents ("A$300"). The minimum must be lowered with the
// maximum: AUD defaults to a minimum of 2, and max < min throws a RangeError
// that crashes the whole block.
function money(amount, currency) {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return shopify.i18n.formatCurrency(amount, {
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// "01 Sep 2027", per the design.
function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return shopify.i18n.formatDate(date, { day: "2-digit", month: "short", year: "numeric" });
}

// "Gold AU" -> "Gold": Omneo suffixes tier names with the region, which the
// customer doesn't need to see.
function tierLabel(name) {
  return String(name || "").replace(/\s+(AU|UK|EU|US)$/i, "") || name;
}

// Editor-only preview data, so both states can be checked in the customer
// account editor (its preview customer isn't in Omneo, so live data is always
// the Join card there).
const PREVIEW_MEMBER = {
  member: true,
  currency: "AUD",
  tier: { name: "Gold AU", handle: "gold-au" },
  nextTier: { name: "Diamond AU", handle: "diamond-au", min: 500 },
  spent: 300,
  remaining: 200,
  progress: 60,
  maintainRemaining: 0,
  maintainedUntil: "2027-07-24T13:59:59.000Z",
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

  // Every slot stays in the same position whatever the status, so the birthday
  // card (which loads on its own) isn't remounted when the Omneo data arrives.
  return (
    <s-stack gap="base">
      {switcher}
      {firstName && <s-heading>{t("greeting", { name: firstName })}</s-heading>}
      <ClubCards status={status} />
      {!shopify.settings?.value?.hide_birthday && <BirthdayCard />}
    </s-stack>
  );
}

function ClubCards({ status }) {
  if (status === undefined) return <ClubSkeleton />;
  // On a backend/Omneo failure, show nothing: guessing would risk telling a
  // member to "Join the club".
  if (status === null) return null;
  if (!status.member) return <JoinCard />;
  return (
    <>
      <LevelCard status={status} />
      {status.balance !== null && <BalanceCard status={status} />}
    </>
  );
}

// Placeholder level + balance cards while Omneo loads, shaped like the real
// ones so the page doesn't jump when they arrive.
function ClubSkeleton() {
  return (
    <>
      <s-section>
        <s-stack gap="base">
          <s-heading>{t("levelTitle")}</s-heading>
          <s-skeleton-paragraph />
          <s-divider />
          <s-skeleton-paragraph />
        </s-stack>
      </s-section>
      <s-section>
        <s-stack gap="base">
          <s-heading>{t("balanceTitle")}</s-heading>
          <s-skeleton-paragraph />
        </s-stack>
      </s-section>
    </>
  );
}

// Two pieces of content on one line, pushed to opposite edges.
function SplitRow({ children }) {
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
      {children}
    </s-stack>
  );
}

// The customer's current tier and their progress to the next one. A top-tier
// member gets a full bar.
function TierProgress({ status }) {
  const { tier, nextTier, currency, remaining, progress } = status;
  return (
    <s-stack gap="small-300">
      <s-text type="strong">{tierLabel(tier.name)}</s-text>
      {nextTier ? (
        <>
          <s-progress
            value={progress ?? 0}
            max={100}
            accessibilityLabel={t("progressLabel", { tier: tierLabel(nextTier.name) })}
          />
          {remaining !== null && (
            <s-text>
              {t("toEarnTier", {
                amount: money(remaining, currency),
                tier: tierLabel(nextTier.name),
              })}
            </s-text>
          )}
        </>
      ) : (
        <>
          <s-progress value={100} max={100} accessibilityLabel={t("topTier")} />
          <s-text color="subdued">{t("topTier")}</s-text>
        </>
      )}
    </s-stack>
  );
}

// Same content as the Omneo "Honey Club Level" block, current tier only:
// tier + yearly progress, progress to the next tier, and what's needed to
// keep the current one.
function LevelCard({ status }) {
  const { tier, nextTier, currency, spent, maintainRemaining, maintainedUntil } = status;
  const until = maintainedUntil ? formatDate(maintainedUntil) : "";

  return (
    <s-section>
      <s-stack gap="base">
        <SplitRow>
          <s-heading>{t("levelTitle")}</s-heading>
          <s-badge>{tierLabel(tier.name)}</s-badge>
        </SplitRow>
        <SplitRow>
          <s-text color="subdued">{t("yearlyProgress")}</s-text>
          <s-text type="strong">
            {nextTier?.min
              ? `${money(spent, currency)} / ${money(nextTier.min, currency)}`
              : money(spent, currency)}
          </s-text>
        </SplitRow>

        <s-divider />

        <TierProgress status={status} />

        {/* Secondary info: one small, subdued line under the progress. */}
        {maintainRemaining != null && (
          <s-text type="small" color="subdued">
            {t(until ? "maintainNeededBy" : "maintainNeeded", {
              amount: money(maintainRemaining, currency),
              tier: tierLabel(tier.name),
              date: until,
            })}
          </s-text>
        )}
      </s-stack>
    </s-section>
  );
}

// Same content as the Omneo "Honey Club Balance" block: heading + amount, then
// a centred "Your Honey Club balance / amount / Total value available" panel.
function BalanceCard({ status }) {
  const amount = money(status.balance, status.currency);
  return (
    <s-section>
      <s-stack gap="base">
        <SplitRow>
          <s-stack gap="small-500">
            <s-heading>{t("balanceTitle")}</s-heading>
            <s-text color="subdued">{t("balanceSubtitle")}</s-text>
          </s-stack>
          <s-heading>{amount}</s-heading>
        </SplitRow>
        <s-box border="base" padding="base">
          <s-stack gap="small-300" alignItems="center">
            <s-text color="subdued">{t("balanceBoxTitle")}</s-text>
            <s-text type="strong">{amount}</s-text>
            <s-text color="subdued">{t("balanceBoxNote")}</s-text>
          </s-stack>
        </s-box>
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
