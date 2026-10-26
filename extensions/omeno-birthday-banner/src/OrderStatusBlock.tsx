import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useAuthenticatedAccountCustomer,
  useSettings,
  useTranslate,
} from "@shopify/ui-extensions/customer-account/preact";

// Single entry point. It serves every target that points at this module in
// shopify.extension.toml (profile, order status and order index blocks).
export default function extension() {
  render(<CustomerBirthdayBlock />, document.body);
}

// Birthday backend (separate Render service: honey-birdette-birthday-app).
// Called directly rather than via each store's app proxy, so no per-store URL.
const BACKEND_URL = "https://honey-birdette-birthday-app.onrender.com";

// Region label per store (debug display only; the backend keys off the shop).
const SHOP_REGIONS: Record<string, string> = {
  "honey-birdette-2.myshopify.com": "AU",
  "honey-birdette-uk.myshopify.com": "UK",
  "honey-birdette-eu.myshopify.com": "EU",
  "honey-birdette-usa.myshopify.com": "US",
  "honeybirdette-us.myshopify.com": "US",
};

// The store this customer account belongs to, read from the session token's
// `dest` claim (the shop's myshopify domain). Only used to route the request,
// so decoding without verifying is fine here.
async function currentShopDomain(): Promise<string> {
  const token = await shopify.sessionToken.get();
  const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
  return String(claims.dest || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// The change event is typed as a plain Event, so narrow its target to read
// the selected value (the old Select passed the value string directly).
function selectValue(event: Event): string {
  const target = event.currentTarget as HTMLElementTagNameMap["s-select"];
  return target.value ?? "";
}

function CustomerBirthdayBlock() {
  const authenticatedCustomer = useAuthenticatedAccountCustomer();

  // Read settings configured by merchant in Shopify admin
  const settings = useSettings();

  // The store is detected from the session token, so the same block works on
  // the AU, UK, EU and US stores without per-store settings.
  const [shop, setShop] = useState("");
  const storeConfig = {
    region: SHOP_REGIONS[shop] ?? "DEV",
    shopifyDomain: shop,
    proxyUrl: BACKEND_URL,
    showDebug: settings.show_debug !== undefined ? settings.show_debug : false // Hidden unless enabled in admin
  };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();

  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  // The birthday as stored; the form edits day/month until saved.
  const [savedDay, setSavedDay] = useState("");
  const [savedMonth, setSavedMonth] = useState("");
  const [editing, setEditing] = useState(false);
  const [customerId, setCustomerId] = useState<string>("");
  const [showDebug, setShowDebug] = useState(false);
  const [debug, setDebug] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const translate = useTranslate();

  useEffect(() => {
    currentShopDomain()
      .then(setShop)
      .catch((e) => {
        console.error("❌ Could not detect store:", e);
        setError("We couldn't load your birthday. Please refresh the page.");
        setLoading(false);
      });
  }, []);

  // Log configuration on mount
  useEffect(() => {
    console.log("🔧 Extension Configuration:");
    console.log("   Region:", storeConfig.region);
    console.log("   Shopify Domain:", storeConfig.shopifyDomain);
    console.log("   Proxy URL:", storeConfig.proxyUrl);
    console.log("   Settings:", settings);
  }, [storeConfig.region, storeConfig.shopifyDomain, storeConfig.proxyUrl]);

  // Get customer ID
  useEffect(() => {
    if (authenticatedCustomer?.id) {
      const id = String(authenticatedCustomer.id);
      setCustomerId(id);
      console.log("✅ Customer ID:", id);
    }
  }, [authenticatedCustomer]);

  // Fetch customer tags on mount
  useEffect(() => {
    async function fetchCustomerTags() {
      try {
        if (!customerId || !shop) {
          console.log("⏳ Waiting for customer ID and store...");
          return;
        }

        console.log("📥 Fetching birthday metafields for customer:", customerId);
        console.log("   Region:", storeConfig.region);
        console.log("   Shop:", storeConfig.shopifyDomain);

        const resp = await fetch(
          `${BACKEND_URL}/get-tags?customerId=${customerId}&shop=${shop}`,
          {
            method: "GET",
            headers: { "Content-Type": "application/json" },
          }
        );

        const result = await resp.json();
        const debugInfo = {
          region: storeConfig.region,
          shopifyDomain: storeConfig.shopifyDomain,
          proxyUrl: storeConfig.proxyUrl,
          customerId: customerId,
          settings: settings,
          response: result
        };
        setDebug(JSON.stringify(debugInfo, null, 2));
        console.log("📋 Birthday result:", result);

        if (result.success && result.metafields) {
          const metafields = result.metafields;

          // Read birthday from metafields
          const birthdayDay = metafields.birthday_day;
          const birthdayMonth = metafields.birthday_month;

          if (birthdayDay && birthdayMonth) {
            // Pad with zeros for display
            const paddedDay = String(birthdayDay).padStart(2, '0');
            const paddedMonth = String(birthdayMonth).padStart(2, '0');

            setDay(paddedDay);
            setMonth(paddedMonth);
            setSavedDay(paddedDay);
            setSavedMonth(paddedMonth);
            console.log(`🎂 Found birthday: ${paddedDay}/${paddedMonth} (from metafields)`);
          } else {
            console.log("ℹ️ No birthday metafields found");
          }
        }
      } catch (e: any) {
        console.error("❌ Error fetching birthday:", e);
        setError(e?.message || "Error loading customer data");
      } finally {
        setLoading(false);
      }
    }

    fetchCustomerTags();
  }, [customerId, shop, refreshKey]);

  async function save() {
    setError(undefined);
    setSaved(undefined);

    const dayVal = day.trim();
    const monthVal = month.trim();

    // Validate day (1-31)
    if (dayVal) {
      const dayNum = parseInt(dayVal, 10);
      if (isNaN(dayNum) || dayNum < 1 || dayNum > 31) {
        setError("Day must be between 1 and 31");
        return;
      }
    }

    // Validate month (1-12)
    if (monthVal) {
      const monthNum = parseInt(monthVal, 10);
      if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
        setError("Month must be between 1 and 12");
        return;
      }
    }

    // Both or neither
    if ((dayVal && !monthVal) || (!dayVal && monthVal)) {
      setError("Please enter both day and month");
      return;
    }

    // Check if there's anything to save
    if (!dayVal && !monthVal) {
      setSaved("No changes to save");
      setTimeout(() => setSaved(undefined), 2000);
      return;
    }

    setSaving(true);
    try {
      const paddedDay = dayVal.padStart(2, '0');
      const paddedMonth = monthVal.padStart(2, '0');
      const birthdayTag = `birthday_${paddedDay}_${paddedMonth}`;

      console.log("💾 Saving birthday:", birthdayTag);
      console.log("   Region:", storeConfig.region);
      console.log("   Shop:", storeConfig.shopifyDomain);

      const resp = await fetch(`${BACKEND_URL}/add-tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tags: [birthdayTag],
          shop: storeConfig.shopifyDomain,
          customerId: customerId,
        }),
      });

      const result = await resp.json();
      setDebug(JSON.stringify({
        region: storeConfig.region,
        shopifyDomain: storeConfig.shopifyDomain,
        request: { tags: [birthdayTag] },
        response: result
      }, null, 2));

      if (!resp.ok) {
        setError(result?.error || "Failed to save");
        return;
      }

      if (result?.userErrors?.length > 0) {
        setError(result.userErrors.map((e: any) => e.message).join(", "));
        return;
      }

      console.log("✅ Birthday saved!");
      // Show the saved view straight away; the re-fetch below confirms it.
      setSavedDay(paddedDay);
      setSavedMonth(paddedMonth);
      setEditing(false);

      // Re-fetch so the widget shows what the server actually stored
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      console.error("❌ Save error:", e);
      setError(e?.message || "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  const dayOptions = [
    { value: "", label: "--" },
    ...Array.from({ length: 31 }, (_, i) => {
      const v = String(i + 1).padStart(2, "0");
      return { value: v, label: v };
    }),
  ];

  const monthOptions = [
    { value: "", label: "--" },
    { value: "01", label: translate("january") },
    { value: "02", label: translate("february") },
    { value: "03", label: translate("march") },
    { value: "04", label: translate("april") },
    { value: "05", label: translate("may") },
    { value: "06", label: translate("june") },
    { value: "07", label: translate("july") },
    { value: "08", label: translate("august") },
    { value: "09", label: translate("september") },
    { value: "10", label: translate("october") },
    { value: "11", label: translate("november") },
    { value: "12", label: translate("december") },
  ];

  if (loading) {
    return (
      <s-section>
        <s-stack gap="base">
          <s-heading>{translate("savedTitle")}</s-heading>
          <s-skeleton-paragraph />
        </s-stack>
      </s-section>
    );
  }

  const hasBirthday = Boolean(savedDay && savedMonth);

  function cancelEdit() {
    setDay(savedDay);
    setMonth(savedMonth);
    setError(undefined);
    setEditing(false);
  }

  // Saved view: "Your birthday / 4 April / Thanks for sharing... / Edit".
  if (hasBirthday && !editing) {
    const monthLabel =
      monthOptions.find((option) => option.value === savedMonth)?.label ?? savedMonth;
    return (
      <s-section>
        <s-stack gap="base">
          <s-heading>{translate("savedTitle")}</s-heading>
          <s-text>{`${parseInt(savedDay, 10)} ${monthLabel}`}</s-text>
          <s-text color="subdued">{translate("savedNote")}</s-text>
          <s-link onClick={() => setEditing(true)}>{translate("edit")}</s-link>
        </s-stack>
      </s-section>
    );
  }

  // Form view: no birthday yet, or editing an existing one.
  return (
    <s-section>
      <s-stack gap="base">
        <s-stack gap="small-300">
          <s-heading>{translate("formTitle")}</s-heading>
          <s-text color="subdued">{translate("formDescription")}</s-text>
        </s-stack>

        {storeConfig.showDebug && (
          <s-text type="small" color="subdued">
            Region: {storeConfig.region} · Customer ID: {customerId || "Loading..."}
          </s-text>
        )}

        <s-form onSubmit={save}>
          <s-stack gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select
                label={translate("dayLabel")}
                value={day}
                onChange={(event) => setDay(selectValue(event))}
              >
                {dayOptions.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
              <s-select
                label={translate("monthLabel")}
                value={month}
                onChange={(event) => setMonth(selectValue(event))}
              >
                {monthOptions.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
            </s-grid>

            {error && (
              <s-banner tone="critical">
                <s-text>{error}</s-text>
              </s-banner>
            )}

            {saved && (
              <s-banner tone="success">
                <s-text>{saved}</s-text>
              </s-banner>
            )}

            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button variant="primary" type="submit" loading={saving} disabled={saving}>
                {saving ? translate("saving") : translate("saveBirthday")}
              </s-button>
              {hasBirthday && (
                <s-link onClick={cancelEdit}>{translate("cancel")}</s-link>
              )}
            </s-stack>

            {storeConfig.showDebug && (
              <s-button variant="secondary" onClick={() => setShowDebug((v) => !v)}>
                {showDebug ? "Hide debug" : "Show debug"}
              </s-button>
            )}

            {showDebug && debug && (
              <s-stack gap="small-200">
                <s-text type="small">Debug info:</s-text>
                <s-text type="small">{debug}</s-text>
              </s-stack>
            )}
          </s-stack>
        </s-form>
      </s-stack>
    </s-section>
  );
}
