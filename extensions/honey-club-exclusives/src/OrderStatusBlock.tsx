import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";
import {
  useAuthenticatedAccountCustomer,
  useSettings,
} from "@shopify/ui-extensions/customer-account/preact";

// The target is bound in shopify.extension.toml
// (customer-account.profile.block.render -> this module).
export default function extension() {
  render(<HoneyClubExclusives />, document.body);
}

// Container width (px) above which the image sits beside the copy instead of
// above it. Measured on the block's own container, not the viewport.
const TWO_COLUMN_MIN_INLINE_SIZE = 600;

// Fallbacks so the block still renders in dev if settings aren't configured.
// Replace these placeholders with real values in the extension's admin settings.
const DEFAULT_CONFIG = {
  region: "AU",
  shopifyDomain: "honey-birdette-2.myshopify.com",
  proxyUrl: "https://www.honeybirdette.com",
  desktopImageUrl:
    "https://cdn.shopify.com/s/files/1/0585/9581/files/Top_Banner_4_75e18449-3b0a-4ad5-a631-e90f5100f6e3.jpg?v=1775539058",
  mobileImageUrl:
    "https://cdn.shopify.com/s/files/1/0585/9581/files/Cherry_Cuff12.jpg?v=1781588996",
  unlockTag: "dress-circle",
  eyebrow: "The Honey Club Exclusive",
  headingUnlocked: "Honey Club Exclusives",
  messageUnlocked: "Your members-only collection is unlocked. Shop it now.",
  ctaUnlockedText: "Shop the collection",
  ctaUnlockedUrl: "https://www.honeybirdette.com/collections/dress-circle-exclusives",
  headingLocked: "Honey Club Exclusives",
  messageLocked: "Reach Dress Circle to unlock members-only pieces.",
  ctaLockedText: "How to unlock",
  ctaLockedUrl: "https://www.honeybirdette.com/pages/the-honey-club",
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

  const desktopImageUrl = str(settings.desktop_image_url) || DEFAULT_CONFIG.desktopImageUrl;
  const mobileImageUrl = str(settings.mobile_image_url) || DEFAULT_CONFIG.mobileImageUrl;
  const unlockTag = (str(settings.unlock_tag) || DEFAULT_CONFIG.unlockTag).toLowerCase();
  const eyebrow = str(settings.eyebrow) || DEFAULT_CONFIG.eyebrow;

  const headingUnlocked = str(settings.heading_unlocked) || DEFAULT_CONFIG.headingUnlocked;
  const messageUnlocked = str(settings.message_unlocked) || DEFAULT_CONFIG.messageUnlocked;
  const ctaUnlockedText = str(settings.cta_unlocked_text) || DEFAULT_CONFIG.ctaUnlockedText;
  const ctaUnlockedUrl = str(settings.cta_unlocked_url) || DEFAULT_CONFIG.ctaUnlockedUrl;

  const headingLocked = str(settings.heading_locked) || DEFAULT_CONFIG.headingLocked;
  const messageLocked = str(settings.message_locked) || DEFAULT_CONFIG.messageLocked;
  const ctaLockedText = str(settings.cta_locked_text) || DEFAULT_CONFIG.ctaLockedText;
  const ctaLockedUrl = str(settings.cta_locked_url) || DEFAULT_CONFIG.ctaLockedUrl;

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

  // The card shows a square product shot beside the copy, so the (square)
  // mobile image is preferred over the wide desktop banner.
  const imageUrl = mobileImageUrl || desktopImageUrl;

  // Nothing to show without imagery.
  if (!imageUrl) {
    return null;
  }

  const heading = unlocked ? headingUnlocked : headingLocked;
  const message = unlocked ? messageUnlocked : messageLocked;
  const ctaText = unlocked ? ctaUnlockedText : ctaLockedText;
  const ctaUrl = unlocked ? ctaUnlockedUrl : ctaLockedUrl;

  // Design: image left, eyebrow / heading / copy / button right; stacks on
  // narrow containers. Same pattern as the honey-club-status Join card.
  return (
    <s-section>
      <s-query-container>
        <s-grid
          gridTemplateColumns={`@container (inline-size > ${TWO_COLUMN_MIN_INLINE_SIZE}px) 1fr 1fr, 1fr`}
          gap="large-100"
          alignItems="center"
        >
          <s-image src={imageUrl} alt={heading} aspectRatio="1" objectFit="cover" borderRadius="base" />
          <s-stack gap="base">
            <s-text color="subdued">{eyebrow}</s-text>
            <s-heading>{heading}</s-heading>
            {/* While tags resolve, show neutral copy to avoid flashing a CTA. */}
            <s-paragraph color="subdued">
              {loading ? "Loading your Honey Club perks…" : message}
            </s-paragraph>
            {!loading && ctaUrl ? (
              <s-button href={ctaUrl} variant="primary">
                {ctaText}
              </s-button>
            ) : null}
          </s-stack>
        </s-grid>
      </s-query-container>
    </s-section>
  );
}
