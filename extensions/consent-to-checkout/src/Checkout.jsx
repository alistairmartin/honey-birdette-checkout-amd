import {
  reactExtension,
  Checkbox,
  useExtensionCapability,
  useBuyerJourneyIntercept,
  BlockStack,
  Banner,
  Text,
  Link,
} from "@shopify/ui-extensions-react/checkout";
import React, { useState } from "react";

// Set the entry point for the extension
export default reactExtension("purchase.checkout.block.render", () => <App />);

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
    <BlockStack>
      <Banner status="warning" title="">
        <Checkbox
          label="By placing your order, you agree to our Terms and Conditions and Privacy Policy."
          checked={isAccepted}
          onChange={(newValue) => {
            setIsAccepted(newValue);
            if (newValue) clearValidationErrors();
          }}
          error={validationError}
          required
        >
          By placing your order, you agree to our{' '}
          <Link to="https://us.honeybirdette.com/pages/privacy-policy">
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link to="https://us.honeybirdette.com/pages/terms-conditions">
            Terms and Conditions
          </Link>.
        </Checkbox>
      </Banner>
    </BlockStack>
  );
}
