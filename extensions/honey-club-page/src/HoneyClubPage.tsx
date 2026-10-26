// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-07 API). No React / @shopify/ui-extensions-react.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { BirthdayCard } from "./Birthday";

// The target is bound in shopify.extension.toml
// (customer-account.page.render -> this module).
export default async () => {
  render(<HoneyClubPage />, document.body);
};

// The AMD Checkout app backend (Render). Same for every store.
const API_URL = "https://honey-birdette-checkout-amd.onrender.com";

// Per store: storefront (for links back to the Honey Club page, FAQs etc.) and
// the join form's `location`, which is the shop's myshopify handle (AU's
// "Join Now" button uses ?location=honey-birdette-2). The page target's API has
// no shop.storefrontUrl, so the shop comes from the session token instead.
const STOREFRONTS = {
  "honey-birdette-2.myshopify.com": "https://www.honeybirdette.com",
  "honey-birdette-uk.myshopify.com": "https://uk.honeybirdette.com",
  "honey-birdette-eu.myshopify.com": "https://eu.honeybirdette.com",
  "honey-birdette-usa.myshopify.com": "https://us.honeybirdette.com",
  "honeybirdette-us.myshopify.com": "https://us.honeybirdette.com",
};
const DEFAULT_SHOP = "honey-birdette-2.myshopify.com";

// Artwork from /pages/the-honey-club (Shopify CDN, shared by every store).
const CDN = "https://www.honeybirdette.com/cdn/shop/files/";
const IMAGES = {
  hero: `${CDN}Header_Desktop_b305ee89-fbea-4415-9447-1359faa6cff6.jpg?v=1761209832&width=1600`,
  join: `${CDN}Join_Now_Desktop.jpg?v=1761210235&width=800`,
  shop: `${CDN}Shop_Desktop.jpg?v=1761210283&width=800`,
  enjoy: `${CDN}Enjoy_Desktop.jpg?v=1761210326&width=800`,
  // Tier artwork, cropped square by the CDN (the renderer ignores aspectRatio
  // and shows the source ratio).
  gold: `${CDN}Gold_Mobile.jpg?v=1761210357&width=600&height=600&crop=center`,
  diamond: `${CDN}Diamond_59b09314-ecb6-4d27-bfaa-6b21f7af494d.jpg?v=1762319320&width=600&height=600&crop=center`,
  platinum: `${CDN}Platnium_Desktop_17529dd3-3cc0-4441-9f25-e6e6a2dc74f3.jpg?v=1762319311&width=600&height=600&crop=center`,
  invite: `${CDN}Invite_Only_Desktop_e71d35fe-3584-4e67-9bcd-b969de98c7cd.jpg?v=1762319316&width=600&height=600&crop=center`,
};

// The tiers as described on /pages/the-honey-club. Spend thresholds come from
// Omneo (status.tiers) when available; `fallbackMin` is the AU site's numbers,
// only used for AUD. Perk amounts are formatted in the store's currency.
const TIERS = [
  {
    key: "gold",
    fallbackMin: 0,
    perks: [
      ["perkFirstPurchase", 30],
      ["perkBirthday", 25],
      ["perkShippingGold", 150],
    ],
  },
  {
    key: "diamond",
    fallbackMin: 500,
    perks: [["perkFirstPurchase", 30], ["perkBirthdayGift", 25], ["perkSeasonal"], ["perkShippingDiamond"]],
  },
  {
    key: "platinum",
    fallbackMin: 3000,
    perks: [
      ["perkFirstPurchase", 30],
      ["perkBirthdayGift", 25],
      ["perkSeasonal"],
      ["perkShippingPlatinum"],
      ["perkEarlyAccess"],
      ["perkBoutique"],
    ],
  },
  { key: "invite", inviteOnly: true, perks: [["perkInvite"]] },
];

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

function setting(settings, key) {
  return typeof settings[key] === "string" ? settings[key].trim() : "";
}

// Whole amounts drop the cents ("A$300"). The minimum must be lowered with the
// maximum: AUD defaults to a minimum of 2, and max < min throws a RangeError.
function money(amount, currency) {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return shopify.i18n.formatCurrency(amount, {
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// "01 Sep 2027", matching the Honey Club cards.
function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return shopify.i18n.formatDate(date, { day: "2-digit", month: "short", year: "numeric" });
}

// "Gold AU" -> "Gold": Omneo suffixes tier names with the region.
function tierLabel(name) {
  return String(name || "").replace(/\s+(AU|UK|EU|US)$/i, "") || name;
}

// Which TIERS entry an Omneo tier ("Gold AU", handle "gold-au") is.
function tierKey(tier) {
  const text = `${tier?.handle || ""} ${tier?.name || ""}`.toLowerCase();
  if (/invite|vip/.test(text)) return "invite";
  return TIERS.find((def) => text.includes(def.key))?.key ?? null;
}

// The store's myshopify domain, from the session token's `dest` claim. Only
// used to pick links, so decoding without verifying is fine.
function shopFromToken(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    return String(claims.dest || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
  } catch {
    return "";
  }
}

// Links are module-level so every component can use them; set once the shop is known.
let currentShop = DEFAULT_SHOP;

// Storefront links. The account lives on a different domain, so they must be absolute.
function storefrontUrl(path) {
  return `${STOREFRONTS[currentShop] || STOREFRONTS[DEFAULT_SHOP]}${path}`;
}

function joinUrl() {
  const shop = STOREFRONTS[currentShop] ? currentShop : DEFAULT_SHOP;
  return `https://join.honeybirdette.com?location=${shop.replace(".myshopify.com", "")}`;
}

function HoneyClubPage() {
  // undefined = loading, null = failed, object = loaded.
  const [status, setStatus] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = await shopify.sessionToken.get();
        currentShop = shopFromToken(token) || DEFAULT_SHOP;
        const resp = await fetch(`${API_URL}/api/honey-club`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
        const data = await resp.json();
        if (!cancelled) setStatus(data);
      } catch (e) {
        console.error("HoneyClubPage: failed to load", e);
        if (!cancelled) setStatus(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const member = status?.member === true;
  // Unknown until loaded; a failed load still shows the generic content.
  const currency = status?.currency || shopify.localization?.currency?.value?.isoCode || "AUD";
  // Hero image can be swapped from the editor (extension settings).
  const settings = shopify.settings?.value ?? {};
  const heroUrl = setting(settings, "hero_image_url") || IMAGES.hero;
  const heroAlt = setting(settings, "hero_image_alt") || t("tagline");

  return (
    <s-page heading={t("pageHeading")}>
      <s-stack gap="base">
        <s-image src={heroUrl} alt={heroAlt} aspectRatio="3" objectFit="cover" borderRadius="base" />

        <LoyaltyMessages status={status} />

        <Status status={status} currency={currency} />

        {member && <BirthdayCard />}

        <TierLadder status={status} currency={currency} />

        {/* Wait for the status so members don't see it flash in then vanish. */}
        {status !== undefined && !member && <HowItWorks />}

        <HelpLinks />
      </s-stack>
    </s-page>
  );
}

// Banners edited in the app admin (/app/loyalty-messaging), per store. Filtered
// here by date (customer's local time, inclusive) and audience. Member-only and
// non-member-only messages wait until the Honey Club status is known.
function LoyaltyMessages({ status }) {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = await shopify.sessionToken.get();
        const resp = await fetch(`${API_URL}/api/loyalty-messages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
        const data = await resp.json();
        if (!cancelled) setMessages(data.messages || []);
      } catch (e) {
        // No banners is fine; the rest of the page doesn't depend on them.
        console.error("HoneyClubPage: failed to load loyalty messages", e);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const now = Date.now();
  const visible = messages.filter((m) => {
    if (m.startsOn && now < new Date(`${m.startsOn}T00:00:00`).getTime()) return false;
    if (m.endsOn && now > new Date(`${m.endsOn}T23:59:59`).getTime()) return false;
    if (m.audience === "members") return status?.member === true;
    if (m.audience === "nonMembers") return status?.member === false;
    return true;
  });

  return visible.map((m) => (
    <s-banner key={m.id} tone={m.tone || "info"} heading={m.heading || undefined}>
      <s-stack gap="small-300">
        <s-text>{m.text}</s-text>
        {m.linkUrl && (
          <s-link href={m.linkUrl.startsWith("/") ? storefrontUrl(m.linkUrl) : m.linkUrl}>
            {m.linkLabel || t("findOutMore")}
          </s-link>
        )}
      </s-stack>
    </s-banner>
  ));
}

// Top of the page: tier + balance for members, the join hero for everyone else.
function Status({ status, currency }) {
  if (status === undefined) {
    return (
      <s-section>
        <s-skeleton-paragraph />
      </s-section>
    );
  }
  // Don't guess on a failure: telling a member to "Join" would be wrong.
  if (status === null) {
    return (
      <s-section>
        <s-text color="subdued">{t("loadError")}</s-text>
      </s-section>
    );
  }
  if (!status.member) return <JoinHero currency={currency} />;

  return (
    <s-query-container>
      <s-grid gridTemplateColumns="@container (inline-size > 700px) 1fr 1fr, 1fr" gap="base">
        <LevelCard status={status} />
        {status.balance !== null && <BalanceCard status={status} />}
      </s-grid>
    </s-query-container>
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

// Same as the honey-club-status level card: tier, yearly spend, progress to
// the next tier, and what's needed to keep the current one.
function LevelCard({ status }) {
  const { tier, nextTier, currency, spent, remaining, progress, maintainRemaining, maintainedUntil } = status;
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

        {nextTier ? (
          <s-stack gap="small-300">
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
          </s-stack>
        ) : (
          <s-stack gap="small-300">
            <s-progress value={100} max={100} accessibilityLabel={t("topTier")} />
            <s-text color="subdued">{t("topTier")}</s-text>
          </s-stack>
        )}

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

function BalanceCard({ status }) {
  return (
    <s-section>
      <SplitRow>
        <s-stack gap="small-500">
          <s-heading>{t("balanceTitle")}</s-heading>
          <s-text color="subdued">{t("balanceSubtitle")}</s-text>
        </s-stack>
        <s-heading>{money(status.balance, status.currency)}</s-heading>
      </SplitRow>
    </s-section>
  );
}

function PerkList({ perks, currency }) {
  return (
    <s-unordered-list>
      {perks.map(([key, amount]) => (
        <s-list-item key={key}>
          {t(key, amount != null ? { amount: money(amount, currency) } : undefined)}
        </s-list-item>
      ))}
    </s-unordered-list>
  );
}

function JoinHero({ currency }) {
  return (
    <s-section>
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 600px) 1fr 1fr, 1fr"
          gap="large-100"
          alignItems="center"
        >
          <s-image src={IMAGES.join} alt="" aspectRatio="1" objectFit="cover" borderRadius="base" />
          <s-stack gap="base">
            <s-text color="subdued">{t("eyebrow")}</s-text>
            <s-heading>{t("joinHeading")}</s-heading>
            <s-paragraph>{t("tagline")}</s-paragraph>
            <PerkList perks={TIERS[0].perks} currency={currency} />
            <s-button variant="primary" href={joinUrl()}>
              {t("joinCta")}
            </s-button>
          </s-stack>
        </s-grid>
      </s-query-container>
    </s-section>
  );
}

// Every tier with its spend range and perks. For members, their tier is marked
// and lower tiers show as unlocked.
function TierLadder({ status, currency }) {
  const omneoTiers = status?.tiers || [];
  const currentKey = status?.member ? tierKey(status.tier) : null;
  const currentIndex = TIERS.findIndex((d) => d.key === currentKey);

  const mins = TIERS.map((def) => {
    const omneo = omneoTiers.find((tier) => tierKey(tier) === def.key);
    if (omneo) return omneo.min;
    return currency === "AUD" ? (def.fallbackMin ?? null) : null;
  });

  function range(i) {
    const from = mins[i];
    if (from == null) return null;
    const next = mins.slice(i + 1).find((m, j) => m != null && !TIERS[i + 1 + j].inviteOnly);
    if (next == null) return t("tierFrom", { from: money(from, currency) });
    return t("tierRange", { from: money(from, currency), to: money(next - 1, currency) });
  }

  return (
    <s-section heading={t("tiersHeading")}>
      <s-stack gap="base">
        <s-text color="subdued">{t("tiersNote")}</s-text>
        <s-stack gap="base">
          {TIERS.map((def, i) => {
            // Invite Only is hidden for now; delete this line to show it again.
            if (def.inviteOnly) return null;
            const rangeText = def.inviteOnly ? null : range(i);
            return (
              <s-box key={def.key} border="base" borderRadius="base" padding="base">
                {/* Image always to the left of the details, a third of the card. */}
                <s-grid gridTemplateColumns="1fr 2fr" gap="base" alignItems="center">
                  <s-image
                    src={IMAGES[def.key]}
                    alt=""
                    inlineSize="fill"
                    aspectRatio="1"
                    objectFit="cover"
                    borderRadius="base"
                  />
                  <s-stack gap="small-300">
                    <SplitRow>
                      <s-heading>{def.inviteOnly ? t("inviteOnly") : tierName(def, omneoTiers)}</s-heading>
                      {i === currentIndex && <s-badge>{t("currentTier")}</s-badge>}
                      {currentIndex > i && !def.inviteOnly && (
                        <s-badge color="subdued">{t("achieved")}</s-badge>
                      )}
                      {def.inviteOnly && <s-badge>{t("comingSoon")}</s-badge>}
                    </SplitRow>
                    {rangeText && (
                      <s-text type="small" color="subdued">
                        {rangeText}
                      </s-text>
                    )}
                    <PerkList perks={def.perks} currency={currency} />
                  </s-stack>
                </s-grid>
              </s-box>
            );
          })}
        </s-stack>
        <s-text type="small" color="subdued">
          * <s-link href={storefrontUrl("/pages/terms-conditions")}>{t("linkTerms")}</s-link>
        </s-text>
      </s-stack>
    </s-section>
  );
}

// Omneo's tier name ("Diamond AU" -> "Diamond") if it has one, else the key.
function tierName(def, omneoTiers) {
  const omneo = omneoTiers.find((tier) => tierKey(tier) === def.key);
  return omneo ? tierLabel(omneo.name) : def.key.charAt(0).toUpperCase() + def.key.slice(1);
}

function HowItWorks() {
  const steps = [
    { image: IMAGES.join, title: "stepJoin", body: "stepJoinBody" },
    { image: IMAGES.shop, title: "stepShop", body: "stepShopBody" },
    { image: IMAGES.enjoy, title: "stepEnjoy", body: "stepEnjoyBody" },
  ];
  return (
    <s-section heading={t("howHeading")}>
      {/* Compact numbered rows, thumbnail left, like the tier cards. Full-width
          images were huge on desktop. */}
      <s-stack gap="base">
        {steps.map((step, i) => (
          <s-box key={step.title} border="base" borderRadius="base" padding="base">
            <s-grid gridTemplateColumns="1fr 3fr" gap="base" alignItems="center">
              <s-image
                src={step.image}
                alt=""
                inlineSize="fill"
                aspectRatio="1"
                objectFit="cover"
                borderRadius="base"
              />
              <s-stack gap="small-300">
                <s-text type="small" color="subdued">
                  {String(i + 1).padStart(2, "0")}
                </s-text>
                <s-heading>{t(step.title)}</s-heading>
                <s-text color="subdued">{t(step.body)}</s-text>
              </s-stack>
            </s-grid>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}

function HelpLinks() {
  const links = [
    ["linkClub", "/pages/the-honey-club"],
    ["linkFaqs", "/pages/faqs"],
    ["linkBoutiques", "/pages/boutique-finder"],
    ["linkContact", "/pages/contact-us"],
  ];
  return (
    <s-section heading={t("helpHeading")}>
      <s-stack direction="inline" gap="base">
        {links.map(([key, path]) => (
          <s-button key={key} variant="secondary" href={storefrontUrl(path)}>
            {t(key)}
          </s-button>
        ))}
      </s-stack>
    </s-section>
  );
}
