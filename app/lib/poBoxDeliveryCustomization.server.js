// Install / toggle / remove the "update PO APO FPO boxes" delivery customization.
//
// Delivery customization functions don't activate natively from admin the way
// discounts do - the function only runs once a DeliveryCustomization record
// points at it (created via deliveryCustomizationCreate). This module drives
// that lifecycle so the merchant can manage it from the embedded app instead of
// running GraphQL by hand. The function takes no configuration, so there is no
// metafield/settings step - just create, enable/disable, delete.

import { adminGraphql } from "./adminGraphql.server";

// The function's admin title (from extensions/update-po-apo-fpo-boxes/locales).
const FUNCTION_TITLE = "update PO APO FPO boxes";
const FUNCTION_API_TYPE = "delivery_customization";

// Title we give the DeliveryCustomization record the merchant sees in
// Settings > Shipping and delivery.
export const CUSTOMIZATION_TITLE =
  "Hide PO/AFO/FPO shipping options for standard addresses (and vice versa)";

// Resolve the Shopify function id for our delivery customization function.
// Prefer an exact title match; fall back to the only delivery_customization
// function this app owns so a locale rename doesn't break installation.
export async function getFunctionId(admin) {
  const body = await adminGraphql(
    admin,
    `#graphql
    query DeliveryFunctions {
      shopifyFunctions(first: 100) {
        nodes {
          id
          title
          apiType
        }
      }
    }`,
  );
  const nodes = body?.data?.shopifyFunctions?.nodes ?? [];
  const deliveryFns = nodes.filter((n) => n.apiType === FUNCTION_API_TYPE);
  const exact = deliveryFns.find((n) => n.title === FUNCTION_TITLE);
  if (exact) return exact.id;
  if (deliveryFns.length === 1) return deliveryFns[0].id;
  return null;
}

// Find the existing DeliveryCustomization record (if any) that targets our
// function, so we can show install state and avoid creating duplicates.
export async function getDeliveryCustomization(admin, functionId) {
  if (!functionId) return null;
  const body = await adminGraphql(
    admin,
    `#graphql
    query DeliveryCustomizations {
      deliveryCustomizations(first: 100) {
        nodes {
          id
          title
          enabled
          functionId
        }
      }
    }`,
  );
  const nodes = body?.data?.deliveryCustomizations?.nodes ?? [];
  return nodes.find((n) => n.functionId === functionId) ?? null;
}

// Combined status for the loader: function id + current customization.
export async function getStatus(admin) {
  const functionId = await getFunctionId(admin);
  const customization = await getDeliveryCustomization(admin, functionId);
  return { functionId, customization };
}

function throwUserErrors(label, userErrors) {
  if (userErrors?.length) {
    const msg = userErrors
      .map((e) => `${(e.field ?? []).join(".")}: ${e.message}`)
      .join("; ");
    throw new Error(`${label}: ${msg}`);
  }
}

// Create + enable the DeliveryCustomization that activates the function.
export async function installCustomization(admin) {
  const functionId = await getFunctionId(admin);
  if (!functionId) {
    throw new Error(
      `Could not find a "${FUNCTION_TITLE}" delivery customization function. Deploy the extension first with "shopify app deploy".`,
    );
  }
  const existing = await getDeliveryCustomization(admin, functionId);
  if (existing) {
    return { id: existing.id, alreadyInstalled: true };
  }
  const body = await adminGraphql(
    admin,
    `#graphql
    mutation Create($input: DeliveryCustomizationInput!) {
      deliveryCustomizationCreate(deliveryCustomization: $input) {
        deliveryCustomization { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        functionId,
        title: CUSTOMIZATION_TITLE,
        enabled: true,
      },
    },
  );
  const result = body?.data?.deliveryCustomizationCreate;
  throwUserErrors("deliveryCustomizationCreate", result?.userErrors);
  return { id: result?.deliveryCustomization?.id, alreadyInstalled: false };
}

// Flip the enabled flag without deleting the record.
export async function setEnabled(admin, id, enabled) {
  const body = await adminGraphql(
    admin,
    `#graphql
    mutation Update($id: ID!, $input: DeliveryCustomizationInput!) {
      deliveryCustomizationUpdate(id: $id, deliveryCustomization: $input) {
        deliveryCustomization { id enabled }
        userErrors { field message }
      }
    }`,
    { id, input: { enabled } },
  );
  const result = body?.data?.deliveryCustomizationUpdate;
  throwUserErrors("deliveryCustomizationUpdate", result?.userErrors);
  return result?.deliveryCustomization;
}

// Remove the customization entirely (the function stops running).
export async function uninstallCustomization(admin, id) {
  const body = await adminGraphql(
    admin,
    `#graphql
    mutation Delete($id: ID!) {
      deliveryCustomizationDelete(id: $id) {
        deletedId
        userErrors { field message }
      }
    }`,
    { id },
  );
  const result = body?.data?.deliveryCustomizationDelete;
  throwUserErrors("deliveryCustomizationDelete", result?.userErrors);
  return result?.deletedId;
}
