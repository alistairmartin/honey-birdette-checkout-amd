// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-07 API).
//
// One personal nudge in the announcement bar, the first that applies:
// close to next tier > birthday month > complete your profile. See
// shopify.extension.toml for the data sources.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<HoneyAnnouncement />, document.body);
};

// The AMD Checkout app backend (Omneo + sizes) and the separate birthday backend.
const API_URL = "https://honey-birdette-checkout-amd.onrender.com";
const BIRTHDAY_API_URL = "https://honey-birdette-birthday-app.onrender.com";

// Dismissed message ids, per page target (the storage API is scoped that way).
const DISMISSED_KEY = "dismissed";
const DEFAULT_TIER_NUDGE_PERCENT = 50;

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

// Same rules as honey-club-status: whole amounts drop the cents, and the
// minimum must be lowered with the maximum or formatCurrency throws.
function money(amount, currency) {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return shopify.i18n.formatCurrency(amount, {
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// "Diamond AU" -> "Diamond".
function tierLabel(name) {
  return String(name || "").replace(/\s+(AU|UK|EU|US)$/i, "") || name;
}

async function getJson(url, init) {
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  return resp.json();
}

async function appBackend(path) {
  const token = await shopify.sessionToken.get();
  return getJson(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

// The shop's myshopify domain from the session token's `dest` claim. Only
// used to route the birthday request, so decoding without verifying is fine.
async function currentShopDomain() {
  const token = await shopify.sessionToken.get();
  const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
  return String(claims.dest || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// The customer's ID; the signal can still be empty on first render.
function customerId() {
  const signal = shopify.authenticatedAccount?.customer;
  if (signal?.value?.id) return Promise.resolve(String(signal.value.id));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no customer id")), 5000);
    const unsubscribe = signal?.subscribe?.((customer) => {
      if (!customer?.id) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(String(customer.id));
    });
  });
}

// { day, month } or null when not set.
async function loadBirthday() {
  const [id, shop] = await Promise.all([customerId(), currentShopDomain()]);
  const result = await getJson(
    `${BIRTHDAY_API_URL}/get-tags?customerId=${encodeURIComponent(id)}&shop=${encodeURIComponent(shop)}`,
  );
  const { birthday_day: day, birthday_month: month } = result?.metafields ?? {};
  return day && month ? { day: Number(day), month: Number(month) } : null;
}

// Candidate messages in priority order. A failed lookup just drops its
// candidates, so a backend outage never produces a wrong nudge.
function buildMessages({ club, birthday, sizes }) {
  const settings = shopify.settings?.value ?? {};
  const onProfile = shopify.extension?.target?.startsWith("customer-account.profile");
  const profileLink = onProfile ? null : "shopify:customer-account/profile";
  const messages = [];

  const threshold = Number(settings.tier_nudge_percent) || DEFAULT_TIER_NUDGE_PERCENT;
  if (
    !settings.hide_tier &&
    club.ok &&
    club.value?.member &&
    club.value.nextTier &&
    club.value.remaining > 0 &&
    (club.value.progress ?? 0) >= threshold
  ) {
    const { nextTier, remaining, currency } = club.value;
    messages.push({
      id: `tier:${nextTier.handle || nextTier.name}`,
      text: t("tierNudge", { amount: money(remaining, currency), tier: tierLabel(nextTier.name) }),
      link: profileLink && { href: profileLink, label: t("tierLink") },
    });
  }

  const now = new Date();
  if (!settings.hide_birthday && birthday.ok && birthday.value?.month === now.getMonth() + 1) {
    messages.push({ id: `birthday:${now.getFullYear()}`, text: t("birthdayMonth") });
  }

  if (!settings.hide_profile) {
    const noBirthday = birthday.ok && !birthday.value;
    const noSizes = sizes.ok && !Object.values(sizes.value?.sizes ?? {}).some(Boolean);
    if (noBirthday || noSizes) {
      messages.push({
        id: "profile",
        text: t(noBirthday ? "profileBirthday" : "profileSizes"),
        link: profileLink && { href: profileLink, label: t("profileLink") },
      });
    }
  }

  return messages;
}

function settle(promise) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => {
      console.error("HoneyAnnouncement:", error);
      return { ok: false };
    },
  );
}

function HoneyAnnouncement() {
  // undefined while loading (renders nothing, so no flash of a lower-priority
  // message), null when nothing applies.
  const [message, setMessage] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [club, birthday, sizes, dismissed] = await Promise.all([
        settle(appBackend("/api/honey-club")),
        settle(loadBirthday()),
        settle(appBackend("/api/size-preference")),
        shopify.storage.read(DISMISSED_KEY).catch(() => null),
      ]);
      const hidden = new Set(Array.isArray(dismissed) ? dismissed : []);
      const next = buildMessages({ club, birthday, sizes }).find((m) => !hidden.has(m.id));
      if (!cancelled) setMessage(next ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!message) return null;

  async function dismiss() {
    try {
      const dismissed = (await shopify.storage.read(DISMISSED_KEY)) ?? [];
      await shopify.storage.write(DISMISSED_KEY, [...new Set([...dismissed, message.id])]);
    } catch (e) {
      console.error("HoneyAnnouncement: failed to save dismissal", e);
    }
  }

  return (
    <s-announcement onDismiss={dismiss}>
      <s-text>{message.text}</s-text>
      {message.link && (
        <>
          {" "}
          <s-link href={message.link.href}>{message.link.label}</s-link>
        </>
      )}
    </s-announcement>
  );
}
