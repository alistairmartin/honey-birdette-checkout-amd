// @ts-nocheck -- Preact UI extension: Polaris web components (s-*) plus the
// global `shopify` object (2026-07 API). Serves both the customer-account and
// thank-you announcement targets; everything it uses (settings, i18n,
// storage) exists on both.
//
// A merchant-written announcement bar driven entirely by the block settings.
// See shopify.extension.toml for the fields.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<StoreAnnouncement />, document.body);
};

const DISMISSED_KEY = "dismissed";

function t(key) {
  return shopify.i18n.translate(key);
}

function setting(key) {
  const value = shopify.settings?.value?.[key];
  return typeof value === "string" ? value.trim() : "";
}

// Today as "YYYY-MM-DD" in the customer's timezone, to compare with the
// settings' date fields (same format).
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isLive(start, end) {
  const day = today();
  return (!start || day >= start) && (!end || day <= end);
}

function StoreAnnouncement() {
  const message = setting("message");
  const linkText = setting("link_text");
  const linkUrl = setting("link_url");
  const detailsHeading = setting("details_heading");
  const detailsBody = setting("details_body");
  const hasDetails = Boolean(detailsBody);

  // A dismissal is remembered against the message text, so a new announcement
  // shows even to customers who closed the previous one.
  // undefined = still reading storage (render nothing, avoids a flash).
  const [dismissed, setDismissed] = useState(undefined);
  useEffect(() => {
    shopify.storage
      .read(DISMISSED_KEY)
      .then((value) => setDismissed(value === message))
      .catch(() => setDismissed(false));
  }, [message]);

  if (!message || !isLive(setting("start_date"), setting("end_date")) || dismissed !== false) {
    return null;
  }

  function dismiss() {
    shopify.storage.write(DISMISSED_KEY, message).catch((e) => {
      console.error("StoreAnnouncement: failed to save dismissal", e);
    });
  }

  return (
    <s-announcement onDismiss={dismiss}>
      <s-text>{message}</s-text>
      {linkText && linkUrl && (
        <>
          {" "}
          <s-link href={linkUrl}>{linkText}</s-link>
        </>
      )}
      {hasDetails && (
        <>
          {" "}
          <s-link command="--show" commandFor="store-announcement-details">
            {setting("details_link_text") || t("seeDetails")}
          </s-link>
          <s-modal id="store-announcement-details" heading={detailsHeading || message}>
            <s-stack gap="base">
              {detailsBody.split(/\n{2,}/).map((paragraph, i) => (
                <s-paragraph key={i}>{paragraph}</s-paragraph>
              ))}
            </s-stack>
            <s-button
              slot="primary-action"
              variant="primary"
              command="--hide"
              commandFor="store-announcement-details"
            >
              {t("gotIt")}
            </s-button>
          </s-modal>
        </>
      )}
    </s-announcement>
  );
}
