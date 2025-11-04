import React, { useEffect, useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Form,
  Text,
  Select,
  Grid,
  View,
  reactExtension,
  useAuthenticatedAccountCustomer,
  useSettings,
  useTranslate,
} from "@shopify/ui-extensions-react/customer-account";

export default reactExtension(
  "customer-account.profile.block.render",
  () => <CustomerBirthdayBlock />
);

// Fallback config if settings aren't configured
const DEFAULT_CONFIG = {
  region: "AU",
  shopifyDomain: "honey-birdette-2.myshopify.com",
  proxyUrl: "https://www.honeybirdette.com"
};

function CustomerBirthdayBlock() {
  const authenticatedCustomer = useAuthenticatedAccountCustomer();
  
  // Read settings configured by merchant in Shopify admin
  const settings = useSettings();
  
  // Get store configuration from settings
  const storeConfig = {
    region: settings.region || DEFAULT_CONFIG.region,
    shopifyDomain: settings.shopify_domain || DEFAULT_CONFIG.shopifyDomain,
    proxyUrl: settings.proxy_url || DEFAULT_CONFIG.proxyUrl,
    showDebug: settings.show_debug !== undefined ? settings.show_debug : true // Default to true for testing
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
  }, [customerId, storeConfig.proxyUrl, storeConfig.shopifyDomain, storeConfig.region]);

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
      <Banner>
        <Text>Loading…</Text>
      </Banner>
    );
  }

  return (
    <View padding="base" cornerRadius="base" background="subdued">
      <BlockStack spacing="base">
        <Text size="large" emphasis="bold">{translate("birthdayTitle")}</Text>
        <Text>{translate("birthdayDescription")}</Text>

         {storeConfig.showDebug && (
        <Text size="small" appearance="subdued">
          Region: {storeConfig.region}
        </Text>
        )}

        {storeConfig.showDebug && (
        <Text size="small" appearance="subdued">
          Customer ID: {customerId || "Loading..."}
        </Text>
         )}

        <Form onSubmit={save}>
          <BlockStack spacing="base">
            <Grid columns={['fill', 'fill']} spacing="loose">
              <View>
                <Select
                  label={translate("dayLabel")}
                  value={day}
                  onChange={(value) => setDay(value)}
                  options={dayOptions}
                />
              </View>
              <View>
                <Select
                  label={translate("monthLabel")}
                  value={month}
                  onChange={(value) => setMonth(value)}
                  options={monthOptions}
                />
              </View>
            </Grid>

            {error && (
              <Banner status="critical">
                <Text>{error}</Text>
              </Banner>
            )}

            {saved && (
              <Banner status="success">
                <Text>{saved}</Text>
              </Banner>
            )}

            <Button kind="primary" submit loading={saving} disabled={saving}>
              {saving ? translate("saving") : translate("saveBirthday")}
            </Button>

            {storeConfig.showDebug && (
              <Button kind="secondary" onPress={() => setShowDebug((v) => !v)}>
                {showDebug ? "Hide debug" : "Show debug"}
              </Button>
            )}

            {showDebug && debug && (
              <BlockStack spacing="tight">
                <Text size="small">Debug info:</Text>
                <Text size="small">{debug}</Text>
              </BlockStack>
            )}
          </BlockStack>
        </Form>
      </BlockStack>
    </View>
  );
}