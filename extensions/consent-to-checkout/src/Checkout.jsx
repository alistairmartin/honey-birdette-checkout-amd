import {
  reactExtension,
  Checkbox,
  useExtensionCapability,
  useBuyerJourneyIntercept,
  BlockStack,
  Banner,
  Text,
} from "@shopify/ui-extensions-react/checkout";
import React, { useState } from "react";


console.log('here lolcats')

// Set the entry point for the extension
export default reactExtension("purchase.checkout.contact.render-after", () => <App />);

function App() {

  console.log('here lolcats')
  // State to track if the terms are accepted
  const [isAccepted, setIsAccepted] = useState(false);
  const [validationError, setValidationError] = useState("");

  // Check if the extension has the capability to block checkout progress
  const canBlockProgress = useExtensionCapability("block_progress");


  // Use the `buyerJourney` intercept to conditionally block checkout progress
  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    if (canBlockProgress && !isAccepted) {
      return {
        behavior: "block",
        reason: "Terms must be accepted",
        perform: (result) => {
          // If progress can be blocked, then set a validation error on the custom field
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

  // Render the checkbox with the label and handle state changes
  return (

    <BlockStack>
    <Banner title="Test" status="warning">
          <Text emphasis="bold" size="medium">
          By placing your order, you agree to our Terms and Conditions and Privacy Policy
          </Text>
    <Checkbox
      label="By placing your order, you agree to our Terms and Conditions and Privacy Policy"
      checked={isAccepted}
      onChange={setIsAccepted}
      error={validationError}
      required={canBlockProgress}
    />
    </Banner>


  </BlockStack>
 
  );
}
