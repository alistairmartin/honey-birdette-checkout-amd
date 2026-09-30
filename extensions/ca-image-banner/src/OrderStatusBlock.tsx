import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { parseAspectRatio, useImageAspectRatio } from "./imageRatio";
import { useSettings } from "@shopify/ui-extensions/customer-account/preact";

// Container width (px) above which the desktop image is shown. The legacy
// Image component switched on viewport width ("medium", 750px). Polaris web
// components switch on the width of the block's container instead, so the
// threshold sits between phone widths and the desktop content column.
const DESKTOP_MIN_CONTAINER_WIDTH = 480;

export default function extension() {
  render(<PromotionBanner />, document.body);
}

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

  // <s-image> frames every image in an aspect ratio box (1/1 by default), so
  // the real ratio has to be supplied or a wide banner gets empty bands above
  // and below. Merchant settings win; otherwise the ratio is read from the file.
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

  if (!defaultSource && !desktopSource) {
    return null;
  }

  // Wait for the ratio so the banner does not flash as a tall square first.
  if (defaultRatio === undefined || desktopRatio === undefined) {
    return null;
  }

  const isResponsive =
    Boolean(defaultSource) &&
    Boolean(desktopSource) &&
    defaultSource !== desktopSource;

  const image = isResponsive ? (
    <s-query-container>
      <s-box
        display={`@container (inline-size > ${DESKTOP_MIN_CONTAINER_WIDTH}px) none, auto`}
      >
        <s-image
          src={defaultSource}
          alt="Promotional banner"
          aspectRatio={defaultRatio || "1/1"}
          objectFit="cover"
        />
      </s-box>
      <s-box
        display={`@container (inline-size > ${DESKTOP_MIN_CONTAINER_WIDTH}px) auto, none`}
      >
        <s-image
          src={desktopSource}
          alt="Promotional banner"
          aspectRatio={desktopRatio || "1/1"}
          objectFit="cover"
        />
      </s-box>
    </s-query-container>
  ) : (
    <s-image
      src={defaultSource || desktopSource}
      alt="Promotional banner"
      aspectRatio={defaultRatio || "1/1"}
      objectFit="cover"
    />
  );

  return (
    <s-stack direction="block" alignItems="center">
      {linkUrl ? (
        <s-clickable
          href={linkUrl}
          target={isExternalUrl(linkUrl) ? "_blank" : "auto"}
          accessibilityLabel="Promotional banner"
        >
          {image}
        </s-clickable>
      ) : (
        image
      )}
    </s-stack>
  );
}

function isExternalUrl(url: string) {
  return /^https?:\/\//i.test(url);
}
