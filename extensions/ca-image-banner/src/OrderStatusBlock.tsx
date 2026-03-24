import {
  BlockStack,
  reactExtension,
  Image,
  Link,
  useSettings,
} from "@shopify/ui-extensions-react/customer-account";

export default reactExtension(
  "customer-account.order-status.block.render",
  () => <PromotionBanner />
);

export const profileBlock = reactExtension(
  "customer-account.profile.block.render",
  () => <PromotionBanner />
);

export const orderIndexBlock = reactExtension(
  "customer-account.order-index.block.render",
  () => <PromotionBanner />
);

function PromotionBanner() {
  const settings = useSettings();

  const desktopImageUrl =
    typeof settings.desktop_image_url === "string"
      ? settings.desktop_image_url.trim()
      : "";
  const mobileImageUrl =
    typeof settings.mobile_image_url === "string"
      ? settings.mobile_image_url.trim()
      : "";
  const linkUrl =
    typeof settings.link_url === "string" ? settings.link_url.trim() : "";

  const defaultSource = mobileImageUrl || desktopImageUrl;
  const desktopSource = desktopImageUrl || mobileImageUrl;

  if (!defaultSource && !desktopSource) {
    return null;
  }

  const imageSource =
    defaultSource &&
    desktopSource &&
    defaultSource !== desktopSource
      ? {
          default: defaultSource,
          conditionals: [
            {
              conditions: { viewportInlineSize: { min: "medium" } },
              value: desktopSource,
            },
          ],
        }
      : defaultSource || desktopSource;

  const image = (
    <Image
      source={imageSource}
      accessibilityDescription="Promotional banner"
    />
  );

  return (
    <BlockStack inlineAlignment="center">
      {linkUrl ? (
        <Link to={linkUrl} external={isExternalUrl(linkUrl)}>
          {image}
        </Link>
      ) : (
        image
      )}
    </BlockStack>
  );
}

function isExternalUrl(url: string) {
  return /^https?:\/\//i.test(url);
}
