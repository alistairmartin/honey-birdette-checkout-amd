import { useApi } from "@shopify/ui-extensions-react/customer-account";

export default function CustomerBirthday() {
  const { query } = useApi();

  async function fetchBirthday() {
    const response = await query(
      `#graphql
      query getCustomerBirthday {
        customer {
          id
          email
          metafield(namespace: "custom", key: "birthday") {
            id
            namespace
            key
            type
            value
          }
        }
      }`
    );

    console.log("Customer birthday metafield:", response);
  }

  fetchBirthday();

  return <></>;
}