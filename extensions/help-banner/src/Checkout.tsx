import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useSettings } from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const { title, description, linkurl, linktext } = useSettings();

  const titleSetting = title ?? "Title";
  const descriptionSetting = description ?? "Descriptin";
  const linkUrl = String(linkurl ?? "https://eu.honeybirdette.com/pages/contact-us");
  const linkText = linktext ?? "Link Text";

  return (
    <s-stack direction="block" gap="base">
      <s-grid gridTemplateColumns="auto 1fr" gap="small-400" alignItems="center">
        <s-icon type="mobile" />
        <s-text type="strong">{titleSetting}</s-text>
      </s-grid>
      <s-paragraph>{descriptionSetting}</s-paragraph>
      <s-box>
        <s-link href={linkUrl}>{linkText}</s-link>
      </s-box>
    </s-stack>
  );
}
