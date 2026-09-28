import "@shopify/ui-extensions/preact";
import { render } from "preact";
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

  if (!defaultSource && !desktopSource) {
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
        <s-image src={defaultSource} alt="Promotional banner" />
      </s-box>
      <s-box
        display={`@container (inline-size > ${DESKTOP_MIN_CONTAINER_WIDTH}px) auto, none`}
      >
        <s-image src={desktopSource} alt="Promotional banner" />
      </s-box>
    </s-query-container>
  ) : (
    <s-image src={defaultSource || desktopSource} alt="Promotional banner" />
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
