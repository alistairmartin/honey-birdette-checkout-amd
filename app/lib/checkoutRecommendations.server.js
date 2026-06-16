// Server helpers for the Checkout Recommendations admin page.
//
// Unlike Gift With Purchase (which keeps Prisma rows as the source of truth and
// publishes a copy), this page stores a single config object directly in the
// SHOP metafield $app:checkout-recommendations / config. The metafield IS the
// source of truth - the admin loader reads it, the action writes it - so there
// is no database table or migration to manage.
//
// The `checkout-recommendations` checkout extension reads the same metafield via
// the storefront API, which is why the definition grants storefront PUBLIC_READ.

import {
  SHOP_METAFIELD_NAMESPACE,
  SHOP_METAFIELD_KEY,
  normalizeConfig,
  emptyConfig,
} from "./checkoutRecommendations.shared";

const GET_CONFIG = `#graphql
  query CheckoutRecsConfig {
    shop {
      id
      metafield(namespace: "${SHOP_METAFIELD_NAMESPACE}", key: "${SHOP_METAFIELD_KEY}") {
        value
      }
    }
  }
`;

const ENSURE_DEFINITION_QUERY = `#graphql
  query CheckoutRecsConfigDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: SHOP, namespace: $namespace, key: $key) {
      nodes { id }
    }
  }
`;

const DEFINITION_CREATE = `#graphql
  mutation CheckoutRecsConfigDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

const SET_METAFIELDS = `#graphql
  mutation CheckoutRecsSetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const jsonResp = await response.json();
  if (jsonResp.errors?.length) {
    throw new Error(`GraphQL error: ${jsonResp.errors.map((e) => e.message).join("; ")}`);
  }
  return jsonResp.data;
}

// The shop metafield must grant storefront read so the checkout extension can
// query it. Safe to call repeatedly: it no-ops once the definition exists.
export async function ensureShopMetafieldDefinition(admin) {
  const data = await gql(admin, ENSURE_DEFINITION_QUERY, {
    namespace: SHOP_METAFIELD_NAMESPACE,
    key: SHOP_METAFIELD_KEY,
  });
  if (data?.metafieldDefinitions?.nodes?.length) return;
  await gql(admin, DEFINITION_CREATE, {
    definition: {
      namespace: SHOP_METAFIELD_NAMESPACE,
      key: SHOP_METAFIELD_KEY,
      name: "Checkout Recommendations config",
      description:
        "Settings and extra rules read by the checkout-recommendations extension via the storefront API.",
      ownerType: "SHOP",
      type: "json",
      access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" },
    },
  });
}

// Read the stored config (normalized). Returns an empty config when nothing has
// been saved yet.
export async function readConfig(admin) {
  await ensureShopMetafieldDefinition(admin);
  const data = await gql(admin, GET_CONFIG);
  const raw = data?.shop?.metafield?.value;
  if (!raw) return emptyConfig();
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return emptyConfig();
  }
}

// Normalize and persist the config to the shop metafield.
export async function saveConfig(admin, rawConfig) {
  await ensureShopMetafieldDefinition(admin);
  const data = await gql(admin, GET_CONFIG);
  const shopId = data?.shop?.id;
  if (!shopId) throw new Error("Could not resolve shop id");

  const config = normalizeConfig(rawConfig);
  const result = await gql(admin, SET_METAFIELDS, {
    metafields: [
      {
        ownerId: shopId,
        namespace: SHOP_METAFIELD_NAMESPACE,
        key: SHOP_METAFIELD_KEY,
        type: "json",
        value: JSON.stringify(config),
      },
    ],
  });
  const errors = result?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(`metafieldsSet failed: ${errors.map((e) => e.message).join(", ")}`);
  }
  return config;
}
