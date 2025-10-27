import React, { useEffect, useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Form,
  Text,
  TextField,
  reactExtension,
  useApi,
  useAuthenticatedAccountCustomer,
} from "@shopify/ui-extensions-react/customer-account";

export default reactExtension(
  "customer-account.profile.block.render",
  () => <CustomerBirthdayBlock />
);

// Map account origins to Shopify store domains and proxy URLs
const REGION_CONFIG: Record<string, { shopifyDomain: string; proxyUrl: string; region: string }> = {
  "account-us.honeybirdette.com": {
    shopifyDomain: "honey-birdette-usa.myshopify.com",
    proxyUrl: "https://us.honeybirdette.com",
    region: "US"
  },
  "account-eu.honeybirdette.com": {
    shopifyDomain: "honey-birdette-eu.myshopify.com",
    proxyUrl: "https://eu.honeybirdette.com",
    region: "EU"
  },
  "account-au.honeybirdette.com": {
    shopifyDomain: "honey-birdette-2.myshopify.com",
    proxyUrl: "https://www.honeybirdette.com",
    region: "AU"
  },
  "account-uk.honeybirdette.com": {
    shopifyDomain: "honey-birdette-uk.myshopify.com",
    proxyUrl: "https://uk.honeybirdette.com",
    region: "UK"
  }
};

// Helper function to get the correct config based on current origin
function getRegionConfig(): { shopifyDomain: string; proxyUrl: string; region: string } {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const config = REGION_CONFIG[hostname];
    
    if (config) {
      console.log(`Detected region: ${config.region}`);
      console.log(`Shopify domain: ${config.shopifyDomain}`);
      console.log(`Proxy URL: ${config.proxyUrl}`);
      return config;
    }
    
    // Fallback for localhost or unknown domains
    if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) {
      console.warn('Running on localhost, using AU as default');
    } else {
      console.warn(`Unknown hostname: ${hostname}, using AU as default`);
    }
  }
  
  // Default fallback to AU
  return {
    shopifyDomain: "honey-birdette-2.myshopify.com",
    proxyUrl: "https://www.honeybirdette.com",
    region: "AU"
  };
}

function CustomerBirthdayBlock() {
  const { sessionToken } = useApi();
  const authenticatedCustomer = useAuthenticatedAccountCustomer();
  const regionConfig = getRegionConfig();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();

  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [customerId, setCustomerId] = useState<string>("");
  const [showDebug, setShowDebug] = useState(false);
  const [debug, setDebug] = useState<string>("");

  // Get customer ID directly from useAuthenticatedAccountCustomer hook
  useEffect(() => {
    if (authenticatedCustomer?.id) {
      // Extract numeric ID from GID
      const idMatch = authenticatedCustomer.id.match(/Customer\/(\d+)/);
      if (idMatch) {
        setCustomerId(idMatch[1]);
        console.log("✅ Customer ID from useAuthenticatedAccountCustomer:", idMatch[1]);
      }
    }
  }, [authenticatedCustomer]);

  // Fetch customer tags on mount
  useEffect(() => {
    async function fetchCustomerTags() {
      try {
        const token = await sessionToken.get();
        const resp = await fetch("/account/api/2025-07/graphql.json", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            query: `
              query GetCustomerTags {
                customer {
                  id
                  tags
                }
              }
            `,
          }),
        });

        const result = await resp.json();
        const debugInfo = {
          region: regionConfig.region,
          shopifyDomain: regionConfig.shopifyDomain,
          proxyUrl: regionConfig.proxyUrl,
          response: result
        };
        setDebug(JSON.stringify(debugInfo, null, 2));
        console.log("Fetch customer tags result:", result);

        const customer = result?.data?.customer;
        if (customer) {
          if (customer.tags) {
            const tags = customer.tags;
          
          // Find birthday tag (format: birthday_DD_MM)
          const birthdayTag = tags.find((tag: string) => tag.startsWith("birthday_"));
          if (birthdayTag) {
            const parts = birthdayTag.split("_");
            if (parts.length === 3) {
              setDay(parts[1]);
              setMonth(parts[2]);
            }
          }
        }
      }
      } catch (e: any) {
        console.error("Error fetching customer tags:", e);
        setError(e?.message || "Error loading customer data");
      } finally {
        setLoading(false);
      }
    }

    fetchCustomerTags();
  }, [sessionToken, regionConfig]);

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

    // Both or neither must be filled
    if ((dayVal && !monthVal) || (!dayVal && monthVal)) {
      setError("Please enter both day and month, or leave both empty");
      return;
      }

    // Check if there's anything to save
    if (!dayVal && !monthVal) {
      setSaved("No changes to save.");
      setTimeout(() => setSaved(undefined), 2000);
      return;
    }

    setSaving(true);
    try {
      const tagsToAdd: string[] = [];

      // Add birthday tag
      const paddedDay = dayVal.padStart(2, '0');
      const paddedMonth = monthVal.padStart(2, '0');
      const birthdayTag = `birthday_${paddedDay}_${paddedMonth}`;
      tagsToAdd.push(birthdayTag);

      console.log("Region:", regionConfig.region);
      console.log("Proxy URL:", regionConfig.proxyUrl);
      console.log("Shop:", regionConfig.shopifyDomain);
      console.log("Customer ID:", customerId);
      console.log("Adding tags:", tagsToAdd);

      // Call app proxy to add the tags
      // Include shop and customerId in body as fallback (for testing)
      // When proxied through Shopify, these come from headers instead
      const resp = await fetch(`${regionConfig.proxyUrl}/apps/omeno-birthday/add-tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tags: tagsToAdd,
          shop: regionConfig.shopifyDomain,
          customerId: customerId,
        }),
      });

      const result = await resp.json();
      setDebug(JSON.stringify({
        region: regionConfig.region,
        request: { tags: tagsToAdd },
        response: result
      }, null, 2));
      console.log("Response:", result);

      if (!resp.ok) {
        setError(result?.error || "Failed to save information");
        return;
      }

      if (result?.userErrors?.length > 0) {
        setError(result.userErrors.map((e: any) => e.message).join(", "));
        return;
      }

      console.log("Save successful!");
      setSaved("Information saved! Updating...");
      
      // Refresh the tags from the server
      setTimeout(async () => {
        try {
          const token = await sessionToken.get();
          const fetchResp = await fetch("/account/api/2025-07/graphql.json", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              query: `
                query GetCustomerTags {
                  customer {
                    tags
                  }
                }
              `,
            }),
          });

          const fetchResult = await fetchResp.json();
          const customer = fetchResult?.data?.customer;
          if (customer?.tags) {
            const tags = customer.tags;
            
            // Update birthday from tags
            const birthdayTag = tags.find((tag: string) => tag.startsWith("birthday_"));
            if (birthdayTag) {
              const parts = birthdayTag.split("_");
              if (parts.length === 3) {
                setDay(parts[1]);
                setMonth(parts[2]);
              }
            }
            
            setSaved("Birthday saved successfully!");
          }
        } catch (e) {
          console.error("Error refreshing:", e);
        }
        setTimeout(() => setSaved(undefined), 3000);
      }, 2000);
    } catch (e: any) {
      console.error("Exception during save:", e);
      setError(e?.message || "Something went wrong while saving");
    } finally {
      setSaving(false);
    }
  }

  const handleDayChange = (value: string) => {
    const cleaned = value.replace(/[^0-9]/g, "").slice(0, 2);
    setDay(cleaned);
  };

  const handleMonthChange = (value: string) => {
    const cleaned = value.replace(/[^0-9]/g, "").slice(0, 2);
    setMonth(cleaned);
  };

  if (loading) {
    return (
      <Banner>
        <Text>Loading…</Text>
      </Banner>
    );
  }

  return (
    <Banner>
      <BlockStack spacing="base">
        <Text size="large" emphasis="bold">Your Birthday</Text>
        <Text>We'll use this to send you a special birthday surprise!</Text>
        <Text size="small" appearance="subdued">Region: {regionConfig.region}</Text>
        <Text size="small" appearance="subdued">Customer ID: {customerId || "Loading..."}</Text>

        <Form onSubmit={save}>
          <BlockStack spacing="base">
            <BlockStack spacing="tight">
              <TextField
                label="Day"
                value={day}
                onChange={handleDayChange}
                type="text"
                inputMode="numeric"
                placeholder="DD"
                maxLength={2}
                helpText="Enter day (1-31)"
              />

              <TextField
                label="Month"
                value={month}
                onChange={handleMonthChange}
                type="text"
                inputMode="numeric"
                placeholder="MM"
                maxLength={2}
                helpText="Enter month (1-12)"
              />
            </BlockStack>

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
              {saving ? "Saving..." : "Save Birthday"}
            </Button>

            <Button kind="secondary" onPress={() => setShowDebug((v) => !v)}>
              {showDebug ? "Hide debug" : "Show debug"}
            </Button>

            {showDebug && debug && (
              <BlockStack spacing="tight">
                <Text size="small">Debug info:</Text>
                <Text size="small">{debug}</Text>
              </BlockStack>
            )}
          </BlockStack>
        </Form>
      </BlockStack>
    </Banner>
  );
}