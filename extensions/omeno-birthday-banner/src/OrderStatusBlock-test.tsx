import React from "react";
import {
  Banner,
  BlockStack,
  Text,
  reactExtension,
  useAuthenticatedAccountCustomer,
} from "@shopify/ui-extensions-react/customer-account";

export default reactExtension(
  "customer-account.profile.block.render",
  () => <SimpleCustomerIdTest />
);

function SimpleCustomerIdTest() {
  const authenticatedCustomer = useAuthenticatedAccountCustomer();
  
  return (
    <Banner>
      <BlockStack spacing="base">
        <Text size="large" emphasis="bold">Customer ID Test</Text>
        <Text>Full GID: {authenticatedCustomer?.id || "No customer ID"}</Text>
        <Text>Numeric ID: {extractNumericId(authenticatedCustomer?.id)}</Text>
      </BlockStack>
    </Banner>
  );
}

// Helper function to extract numeric ID from GID
function extractNumericId(gid: string | undefined): string {
  if (!gid) return "No ID";
  
  const match = gid.match(/Customer\/(\d+)/);
  return match ? match[1] : "Could not parse";
}