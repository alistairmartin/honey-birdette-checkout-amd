import React, {useEffect, useState} from "react";
import {
  BlockStack,
  Button,
  Image,
  Text,
  View,
  reactExtension,
  useAuthenticatedAccountCustomer,
  useSettings,
} from "@shopify/ui-extensions-react/customer-account";

export default reactExtension(
  "customer-account.profile.block.render",
  () => <HoneyClubExclusives />
);

// Fallbacks so the block still renders in dev if settings aren't configured.
const DEFAULT_CONFIG = {
  region: "AU",
  shopifyDomain: "honey-birdette-2.myshopify.com",
  proxyUrl: "https://www.honeybirdette.com",
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// The proxy response shape can vary, so normalise a few likely shapes into a
// flat list of tag strings: { tags: [...] }, { customer: { tags: [...] } },
// or { metafields: { tags: "a,b,c" } }.
function extractTags(result: any): string[] {
  if (!result) return [];
  const raw =
    result.tags ??
    result.customer?.tags ??
    result.metafields?.tags ??
    [];
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
    ? raw.split(/[\s,]+/)
    : [];
  return list.map((t: string) => String(t).trim().toLowerCase()).filter(Boolean);
}

function HoneyClubExclusives() {
  const authenticatedCustomer = useAuthenticatedAccountCustomer();
  const settings = useSettings();

  const desktopImageUrl = str(settings.desktop_image_url);
  const mobileImageUrl = str(settings.mobile_image_url);
  const unlockTag = str(settings.unlock_tag).toLowerCase();

  const headingUnlocked = str(settings.heading_unlocked) || "Honey Club Exclusives";
  const messageUnlocked =
    str(settings.message_unlocked) || "Your members-only collection is unlocked.";
  const ctaUnlockedText = str(settings.cta_unlocked_text) || "Shop the collection";
  const ctaUnlockedUrl = str(settings.cta_unlocked_url);

  const headingLocked = str(settings.heading_locked) || "Honey Club Exclusives";
  const messageLocked =
    str(settings.message_locked) || "Reach the next tier to unlock members-only pieces.";
  const ctaLockedText = str(settings.cta_locked_text) || "How to unlock";
  const ctaLockedUrl = str(settings.cta_locked_url);

  const storeConfig = {
    region: str(settings.region) || DEFAULT_CONFIG.region,
    shopifyDomain: str(settings.shopify_domain) || DEFAULT_CONFIG.shopifyDomain,
    proxyUrl: str(settings.proxy_url) || DEFAULT_CONFIG.proxyUrl,
  };

  const [customerId, setCustomerId] = useState<string>("");
  const [unlocked, setUnlocked] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (authenticatedCustomer?.id) {
      setCustomerId(String(authenticatedCustomer.id));
    }
  }, [authenticatedCustomer]);

  // Read the customer's tags from the app proxy (same endpoint the birthday
  // banner uses) and decide whether the unlock tag is present.
  useEffect(() => {
    async function fetchTags() {
      if (!customerId) return;
      // No tag configured => treat as locked, but don't bother calling.
      if (!unlockTag) {
        setLoading(false);
        return;
      }
      try {
        const resp = await fetch(
          `${storeConfig.proxyUrl}/apps/omeno-birthday/get-tags?customerId=${encodeURIComponent(
            customerId
          )}&shop=${encodeURIComponent(storeConfig.shopifyDomain)}`,
          {method: "GET", headers: {"Content-Type": "application/json"}}
        );
        const result = await resp.json();
        const tags = extractTags(result);
        setUnlocked(tags.includes(unlockTag));
      } catch (e) {
        // Fail closed: on error, keep the locked (aspirational) state.
        console.error("HoneyClubExclusives: failed to read tags", e);
        setUnlocked(false);
      } finally {
        setLoading(false);
      }
    }
    fetchTags();
  }, [customerId, unlockTag, storeConfig.proxyUrl, storeConfig.shopifyDomain]);

  const defaultSource = mobileImageUrl || desktopImageUrl;
  const desktopSource = desktopImageUrl || mobileImageUrl;

  // Nothing to show without imagery.
  if (!defaultSource && !desktopSource) {
    return null;
  }

  // Responsive source: swap to the desktop asset at >= medium viewport.
  const imageSource =
    defaultSource && desktopSource && defaultSource !== desktopSource
      ? {
          default: defaultSource,
          conditionals: [
            {
              conditions: {viewportInlineSize: {min: "medium"}},
              value: desktopSource,
            },
          ],
        }
      : defaultSource || desktopSource;

  const heading = unlocked ? headingUnlocked : headingLocked;
  const message = unlocked ? messageUnlocked : messageLocked;
  const ctaText = unlocked ? ctaUnlockedText : ctaLockedText;
  const ctaUrl = unlocked ? ctaUnlockedUrl : ctaLockedUrl;

  return (
    <View padding="base" cornerRadius="base" background="subdued">
      <BlockStack spacing="base" inlineAlignment="center">
        <Image source={imageSource} accessibilityDescription="Honey Club Exclusives" />
        <BlockStack spacing="tight" inlineAlignment="center">
          <Text size="large" emphasis="bold">
            {heading}
          </Text>
          {/* While tags resolve, show neutral copy to avoid flashing a CTA. */}
          <Text appearance={loading ? "subdued" : "base"}>
            {loading ? "Loading your Honey Club perks…" : message}
          </Text>
        </BlockStack>
        {!loading && ctaUrl ? (
          <Button to={ctaUrl} kind="primary">
            {ctaText}
          </Button>
        ) : null}
      </BlockStack>
    </View>
  );
}
