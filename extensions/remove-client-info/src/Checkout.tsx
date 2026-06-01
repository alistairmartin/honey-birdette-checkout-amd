import { useEffect, useRef } from "react";
import {
  reactExtension,
  useAttributeValues,
  useApplyAttributeChange,
} from "@shopify/ui-extensions-react/checkout";

// The cart attribute we want to strip from the checkout.
const ATTRIBUTE_KEY = "_client_info";

// 1. Choose an extension target
export default reactExtension("purchase.checkout.block.render", () => (
  <Extension />
));

function Extension() {
  const [clientInfo] = useAttributeValues([ATTRIBUTE_KEY]);
  const applyAttributeChange = useApplyAttributeChange();

  // Guard so we only fire the removal once per detected value, even though
  // the component re-renders while the attribute change is applied.
  const removing = useRef(false);

  useEffect(() => {
    // Nothing to do if the attribute is already absent/empty.
    if (clientInfo === undefined || clientInfo === null || clientInfo === "") {
      removing.current = false;
      return;
    }

    if (removing.current) return;
    removing.current = true;

    (async () => {
      try {
        // Checkout UI extensions clear an attribute by setting it to "".
        const result = await applyAttributeChange({
          type: "updateAttribute",
          key: ATTRIBUTE_KEY,
          value: "",
        });

        if (result.type === "error") {
          console.error(`Failed to remove ${ATTRIBUTE_KEY}:`, result.message);
          removing.current = false;
        }
      } catch (err) {
        console.error(`Error removing ${ATTRIBUTE_KEY}:`, err);
        removing.current = false;
      }
    })();
  }, [clientInfo, applyAttributeChange]);

  // This is a side-effect-only component; it renders nothing.
  return null;
}
