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

// Fallback config if settings aren't configured
const DEFAULT_CONFIG = {
  region: "AU",
  shopifyDomain: "honey-birdette-2.myshopify.com",
  proxyUrl: "https://www.honeybirdette.com"
};

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

  // Get store configuration from settings
  const storeConfig = {
    region: settings.region || DEFAULT_CONFIG.region,
    shopifyDomain: settings.shopify_domain || DEFAULT_CONFIG.shopifyDomain,
    proxyUrl: settings.proxy_url || DEFAULT_CONFIG.proxyUrl,
    showDebug: settings.show_debug !== undefined ? settings.show_debug : false // Hidden unless enabled in admin
  };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();

  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [customerId, setCustomerId] = useState<string>("");
  const [showDebug, setShowDebug] = useState(false);
  const [debug, setDebug] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const translate = useTranslate();

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
        if (!customerId) {
          console.log("⏳ Waiting for customer ID...");
          return;
        }

        console.log("📥 Fetching birthday metafields for customer:", customerId);
        console.log("   Region:", storeConfig.region);
        console.log("   Shop:", storeConfig.shopifyDomain);

        const resp = await fetch(
          `${storeConfig.proxyUrl}/apps/omeno-birthday/get-tags?customerId=${customerId}&shop=${storeConfig.shopifyDomain}`,
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
  }, [customerId, refreshKey, storeConfig.proxyUrl, storeConfig.shopifyDomain, storeConfig.region]);

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

      const resp = await fetch(`${storeConfig.proxyUrl}/apps/omeno-birthday/add-tags`, {
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
      setSaved(translate("birthdaySaved"));
      setTimeout(() => setSaved(undefined), 3000);

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
      <s-banner tone="info">
        <s-text>Loading…</s-text>
      </s-banner>
    );
  }

  return (
    <s-box border="base" padding="base" borderRadius="base">
      <s-stack gap="base">
      <s-stack gap="small-400">
        <s-heading>{translate("birthdayTitle")}</s-heading>
        <s-text color="subdued">{translate("birthdayDescription")}</s-text>
      </s-stack>
      <s-divider />
      <s-stack gap="base">
         {storeConfig.showDebug && (
        <s-text type="small" color="subdued">
          Region: {storeConfig.region}
        </s-text>
        )}

        {storeConfig.showDebug && (
        <s-text type="small" color="subdued">
          Customer ID: {customerId || "Loading..."}
        </s-text>
         )}

        <s-form onSubmit={save}>
          <s-stack gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="large-200">
              <s-box>
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
              </s-box>
              <s-box>
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
              </s-box>
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

            <s-button
              variant="primary"
              type="submit"
              inlineSize="fill"
              loading={saving}
              disabled={saving}
            >
              {saving ? translate("saving") : translate("saveBirthday")}
            </s-button>

            {storeConfig.showDebug && (
              <s-button
                variant="secondary"
                inlineSize="fill"
                onClick={() => setShowDebug((v) => !v)}
              >
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
      </s-stack>
    </s-box>
  );
}
