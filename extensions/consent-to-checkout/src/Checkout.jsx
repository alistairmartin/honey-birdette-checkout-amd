import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState } from "preact/hooks";
import {
  useExtensionCapability,
  useBuyerJourneyIntercept,
} from "@shopify/ui-extensions/checkout/preact";

// Set the entry point for the extension
export default function extension() {
  render(<App />, document.body);
}

function App() {
  // State to track if the terms are accepted
  const [isAccepted, setIsAccepted] = useState(false);
  const [validationError, setValidationError] = useState("");

  // Check if the extension has the capability to block checkout progress
  const canBlockProgress = useExtensionCapability("block_progress");

  // Use the `buyerJourney` intercept to conditionally block checkout progress
  useBuyerJourneyIntercept(() => {
    if (canBlockProgress && !isAccepted) {
      return {
        behavior: "block",
        reason: "Terms must be accepted",
        perform: (result) => {
          if (result.behavior === "block") {
            setValidationError("You must accept the Terms and Conditions and Privacy Policy.");
          }
        },
      };
    }

    return {
      behavior: "allow",
      perform: () => {
        clearValidationErrors();
      },
    };
  });

  function clearValidationErrors() {
    setValidationError("");
  }

  return (
    <s-stack direction="block" gap="base">
      <s-banner tone="warning">
        {/* @ts-expect-error The label slot is documented for s-checkbox from API 2026-07, but the JSX typings do not accept children yet. */}
        <s-checkbox
          // Plain text fallback. The label slot below takes precedence when supported.
          label="By placing your order, you agree to our Terms and Conditions and Privacy Policy."
          checked={isAccepted}
          onChange={(event) => {
            const target = /** @type {HTMLInputElement} */ (event.currentTarget);
            const newValue = target.checked;
            setIsAccepted(newValue);
            if (newValue) clearValidationErrors();
          }}
          error={validationError}
          required
        >
          <s-text slot="label">
            By placing your order, you agree to our{" "}
            <s-link href="https://us.honeybirdette.com/pages/privacy-policy">
              Privacy Policy
            </s-link>{" "}
            and{" "}
            <s-link href="https://us.honeybirdette.com/pages/terms-conditions">
              Terms and Conditions
            </s-link>
            .
          </s-text>
        </s-checkbox>
      </s-banner>
    </s-stack>
  );
}
