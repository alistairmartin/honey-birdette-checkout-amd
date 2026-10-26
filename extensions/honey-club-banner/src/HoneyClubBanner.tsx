// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-10 API).
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { parseAspectRatio, useImageAspectRatio } from "./imageRatio";

// The Honey Club full page (extensions/honey-club-page). The extension:
// protocol resolves to that store's /pages/<id> URL, so one value works on
// every regional store.
const HONEY_CLUB_URL = "extension:honey-club-page/";

// Container width (px) above which the desktop image is shown. Matches
// ca-image-banner.
const DESKTOP_MIN_CONTAINER_WIDTH = 480;

export default function extension() {
  render(<HoneyClubBanner />, document.body);
}

function t(key) {
  return shopify.i18n.translate(key);
}

function setting(settings, key) {
  return typeof settings[key] === "string" ? settings[key].trim() : "";
}

function HoneyClubBanner() {
  const settings = shopify.settings?.value ?? {};
  const desktopImageUrl = setting(settings, "desktop_image_url");
  const mobileImageUrl = setting(settings, "mobile_image_url");

  if (!desktopImageUrl && !mobileImageUrl) {
    return <TextCard settings={settings} />;
  }
  return (
    <ImageBanner
      settings={settings}
      desktopImageUrl={desktopImageUrl}
      mobileImageUrl={mobileImageUrl}
    />
  );
}

function ImageBanner({ settings, desktopImageUrl, mobileImageUrl }) {
  const alt = setting(settings, "image_alt") || t("imageAlt");
  const defaultSource = mobileImageUrl || desktopImageUrl;
  const desktopSource = desktopImageUrl || mobileImageUrl;

  // <s-image> frames every image in a 1/1 box unless told the real ratio.
  // Merchant settings win; otherwise it is read from the file.
  const desktopOverride = parseAspectRatio(settings.desktop_image_aspect_ratio);
  const mobileOverride = parseAspectRatio(settings.mobile_image_aspect_ratio);
  const defaultRatio = useImageAspectRatio(
    defaultSource,
    mobileImageUrl ? mobileOverride : desktopOverride,
  );
  const desktopRatio = useImageAspectRatio(
    desktopSource,
    desktopImageUrl ? desktopOverride : mobileOverride,
  );

  // Wait for the ratio so the banner does not flash as a tall square first.
  if (defaultRatio === undefined || desktopRatio === undefined) {
    return null;
  }

  const imageFor = (src, ratio) => (
    <s-image
      src={src}
      alt={alt}
      aspectRatio={ratio || "1/1"}
      objectFit={ratio ? "cover" : "contain"}
    />
  );

  const image =
    defaultSource !== desktopSource ? (
      <s-query-container>
        <s-box
          display={`@container (inline-size > ${DESKTOP_MIN_CONTAINER_WIDTH}px) none, auto`}
        >
          {imageFor(defaultSource, defaultRatio)}
        </s-box>
        <s-box
          display={`@container (inline-size > ${DESKTOP_MIN_CONTAINER_WIDTH}px) auto, none`}
        >
          {imageFor(desktopSource, desktopRatio)}
        </s-box>
      </s-query-container>
    ) : (
      imageFor(defaultSource, defaultRatio)
    );

  return (
    <s-clickable href={HONEY_CLUB_URL} accessibilityLabel={alt}>
      {image}
    </s-clickable>
  );
}

function TextCard({ settings }) {
  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">
            {setting(settings, "eyebrow") || t("eyebrow")}
          </s-text>
          <s-heading>{setting(settings, "heading") || t("heading")}</s-heading>
          <s-paragraph>{setting(settings, "body") || t("body")}</s-paragraph>
        </s-stack>
        <s-stack direction="inline">
          <s-button href={HONEY_CLUB_URL} variant="primary">
            {setting(settings, "cta_text") || t("cta")}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
