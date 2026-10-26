// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-07 API).
//
// "Your birthday" card, ported from the omeno-birthday-banner extension so the
// profile page can show it inside Honey Club Status. Same backend and data:
// the separate birthday Render service stores it as customer metafields
// (custom.birthday_day / birthday_month) and syncs Omneo. The standalone
// banner extension still serves the order status / order index pages.
import { useEffect, useState } from "preact/hooks";

// Birthday backend (separate Render service: honey-birdette-birthday-app).
const BIRTHDAY_API_URL = "https://honey-birdette-birthday-app.onrender.com";

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

// The store this customer account belongs to, from the session token's `dest`
// claim. Only used to route the request, so decoding without verifying is fine.
async function currentShopDomain() {
  const token = await shopify.sessionToken.get();
  const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
  return String(claims.dest || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// The customer's ID. The signal can be empty on first render, so wait for it.
function useCustomerId() {
  const signal = shopify.authenticatedAccount?.customer;
  const [id, setId] = useState(signal?.value?.id ? String(signal.value.id) : "");
  useEffect(() => {
    if (!signal?.subscribe) return;
    return signal.subscribe((customer) => setId(customer?.id ? String(customer.id) : ""));
  }, []);
  return id;
}

// "04" -> "April" in the customer's language.
function monthName(month) {
  return shopify.i18n.formatDate(new Date(2000, Number(month) - 1, 1), { month: "long" });
}

const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0"));
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

export function BirthdayCard() {
  const customerId = useCustomerId();
  const [shop, setShop] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The birthday as stored; the form edits day/month until saved.
  const [savedDay, setSavedDay] = useState("");
  const [savedMonth, setSavedMonth] = useState("");
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    currentShopDomain()
      .then(setShop)
      .catch((e) => {
        console.error("Birthday: could not detect store", e);
        setError(t("birthdayLoadError"));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!customerId || !shop) return;
    let cancelled = false;
    async function load() {
      try {
        const resp = await fetch(
          `${BIRTHDAY_API_URL}/get-tags?customerId=${encodeURIComponent(customerId)}&shop=${encodeURIComponent(shop)}`,
        );
        const result = await resp.json();
        const { birthday_day: d, birthday_month: m } = result?.metafields ?? {};
        if (!cancelled && result?.success && d && m) {
          const paddedDay = String(d).padStart(2, "0");
          const paddedMonth = String(m).padStart(2, "0");
          setSavedDay(paddedDay);
          setSavedMonth(paddedMonth);
          setDay(paddedDay);
          setMonth(paddedMonth);
        }
      } catch (e) {
        console.error("Birthday: failed to load", e);
        if (!cancelled) setError(t("birthdayLoadError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [customerId, shop]);

  async function save() {
    setError("");
    if (!day || !month) {
      setError(t("birthdayBothRequired"));
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch(`${BIRTHDAY_API_URL}/add-tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: [`birthday_${day}_${month}`], shop, customerId }),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok || result?.userErrors?.length) {
        setError(result?.error || result?.userErrors?.map((e) => e.message).join(", ") || t("birthdaySaveError"));
        return;
      }
      setSavedDay(day);
      setSavedMonth(month);
      setEditing(false);
    } catch (e) {
      console.error("Birthday: failed to save", e);
      setError(t("birthdaySaveError"));
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    setDay(savedDay);
    setMonth(savedMonth);
    setError("");
    setEditing(false);
  }

  if (loading) return <BirthdaySkeleton />;

  const hasBirthday = Boolean(savedDay && savedMonth);

  // Saved view: "Your birthday / 4 April / Thanks for sharing... / Edit".
  if (hasBirthday && !editing) {
    return (
      <s-section>
        <s-stack gap="base">
          <s-heading>{t("birthdayTitle")}</s-heading>
          <s-text>{`${Number(savedDay)} ${monthName(savedMonth)}`}</s-text>
          <s-text color="subdued">{t("birthdaySavedNote")}</s-text>
          <s-link onClick={() => setEditing(true)}>{t("birthdayEdit")}</s-link>
        </s-stack>
      </s-section>
    );
  }

  // Form view: no birthday yet, or editing an existing one.
  return (
    <s-section>
      <s-stack gap="base">
        <s-stack gap="small-300">
          <s-heading>{t("birthdayFormTitle")}</s-heading>
          <s-text color="subdued">{t("birthdayFormDescription")}</s-text>
        </s-stack>
        <s-form onSubmit={save}>
          <s-stack gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select
                label={t("birthdayDay")}
                value={day}
                onChange={(event) => setDay(event.currentTarget.value ?? "")}
              >
                <s-option value="">--</s-option>
                {DAY_OPTIONS.map((v) => (
                  <s-option key={v} value={v}>
                    {v}
                  </s-option>
                ))}
              </s-select>
              <s-select
                label={t("birthdayMonth")}
                value={month}
                onChange={(event) => setMonth(event.currentTarget.value ?? "")}
              >
                <s-option value="">--</s-option>
                {MONTH_OPTIONS.map((v) => (
                  <s-option key={v} value={v}>
                    {monthName(v)}
                  </s-option>
                ))}
              </s-select>
            </s-grid>

            {error && (
              <s-banner tone="critical">
                <s-text>{error}</s-text>
              </s-banner>
            )}

            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button variant="primary" type="submit" loading={saving} disabled={saving}>
                {t("birthdaySave")}
              </s-button>
              {hasBirthday && <s-link onClick={cancelEdit}>{t("birthdayCancel")}</s-link>}
            </s-stack>
          </s-stack>
        </s-form>
      </s-stack>
    </s-section>
  );
}

function BirthdaySkeleton() {
  return (
    <s-section>
      <s-stack gap="base">
        <s-heading>{t("birthdayTitle")}</s-heading>
        <s-skeleton-paragraph />
      </s-stack>
    </s-section>
  );
}
