import '@shopify/ui-extensions/preact';
import {render} from "preact";
import {useEffect, useRef} from "preact/hooks";

// Hong Kong has no postcodes and Shopify's HK address form has no postcode
// field. The warehouse (via Kibo) rejects an empty postcode, so we stamp a
// placeholder onto the shipping address whenever the country is HK.
const HK = "HK";
const PLACEHOLDER_ZIP = "00001";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const address = shopify.shippingAddress.value;
  const country = address?.countryCode;
  const zip = (address?.zip || "").trim();
  const canEdit = shopify.instructions.value.delivery.canSelectCustomAddress;

  // Once a call fails we stop retrying for this session so a rejected update
  // never turns into a request loop.
  const inFlight = useRef(false);
  const gaveUp = useRef(false);

  useEffect(() => {
    if (country !== HK || zip !== "" || !canEdit) return;
    if (inFlight.current || gaveUp.current) return;
    if (typeof shopify.applyShippingAddressChange !== "function") return;

    inFlight.current = true;
    shopify
      .applyShippingAddressChange({
        type: "updateShippingAddress",
        address: {zip: PLACEHOLDER_ZIP},
      })
      .then((result) => {
        if (result?.type === "error") {
          gaveUp.current = true;
          console.error("[hk-postcode-default] rejected:", JSON.stringify(result.errors));
        }
      })
      .catch((err) => {
        gaveUp.current = true;
        console.error("[hk-postcode-default] failed:", err?.message || err);
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [country, zip, canEdit]);

  return null;
}
