// Loyalty messaging: the banners shown at the top of the "The Honey Club"
// customer-account page (extensions/honey-club-page). Edited in the app admin
// at /app/loyalty/messaging, read by the page through /api/loyalty-messages.
//
// Stored as one JSON shop metafield in the app-reserved namespace, so it needs
// no metafield definition and only this app can read or write it.

import { normalizeMessage } from "./loyaltyMessages.shared";

const NAMESPACE = "$app:honey_club";
const KEY = "loyalty_messages";

export async function readLoyaltyMessages(admin) {
  const resp = await admin.graphql(
    `#graphql
    query LoyaltyMessages {
      shop {
        id
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
          value
        }
      }
    }`,
  );
  const { data } = await resp.json();
  let parsed = [];
  try {
    parsed = JSON.parse(data?.shop?.metafield?.value || "[]");
  } catch (err) {
    console.error("loyalty messages: bad JSON in metafield", err);
  }
  return {
    shopId: data?.shop?.id ?? null,
    messages: Array.isArray(parsed) ? parsed.map(normalizeMessage) : [],
  };
}

export async function writeLoyaltyMessages(admin, shopId, messages) {
  const resp = await admin.graphql(
    `#graphql
    mutation SetLoyaltyMessages($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors {
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          { ownerId: shopId, namespace: NAMESPACE, key: KEY, type: "json", value: JSON.stringify(messages) },
        ],
      },
    },
  );
  const { data } = await resp.json();
  return (data?.metafieldsSet?.userErrors ?? []).map((e) => e.message);
}
