// Server helpers for the "Gift With Purchase" multi-offer system.
//
// The admin builder page (app.gift-with-purchase.jsx) saves each offer as a
// GwpAppV1Config row. On every change it calls syncConfigs(), which pushes the full
// set to two places:
//   - SHOP metafield  $app:gift-with-purchase / configs  (read by the
//     gift-with-purchase checkout extension via the storefront API). Holds the
//     rich config objects verbatim.
//   - DISCOUNT metafield  $app / function-configuration  (read by the
//     gift-with-purchase-discount Shopify Function). Holds a slim per-offer shape
//     (buildFunctionConfigs) used only to apply the price reduction.
//
// A single automatic app discount is created on demand and bound to the function,
// mirroring app/lib/limitedOffer.server.js.

import prisma from "../db.server";
import {
  FUNCTION_METAFIELD_KEY,
  FUNCTION_METAFIELD_NAMESPACE,
  SHOP_METAFIELD_KEY,
  SHOP_METAFIELD_NAMESPACE,
  buildFunctionConfigs,
} from "./gwpAppV1.shared";

const DISCOUNT_TITLE = "Gift with purchase";
const FUNCTION_HANDLE = "gift-with-purchase-discount";
const DISCOUNT_ID_KEY = "gwp_app_v1_discount_id"; // on the app installation

// --------------------------------------------------------------------------
// GraphQL documents
// --------------------------------------------------------------------------

const GET_CONTEXT = `#graphql
  query GwpAppV1Context {
    currentAppInstallation {
      id
      discountId: metafield(namespace: "$app", key: "gwp_app_v1_discount_id") { value }
    }
    shop { id }
  }
`;

const ENSURE_DEFINITION_QUERY = `#graphql
  query GwpAppV1ConfigDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: SHOP, namespace: $namespace, key: $key) {
      nodes { id }
    }
  }
`;

const DEFINITION_CREATE = `#graphql
  mutation GwpAppV1ConfigDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

const LIST_FUNCTIONS = `#graphql
  query GwpAppV1ListFunctions {
    shopifyFunctions(first: 100) {
      nodes { id apiType title app { title } }
    }
  }
`;

const DISCOUNT_CREATE = `#graphql
  mutation GwpAppV1DiscountCreate($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const GET_DISCOUNT = `#graphql
  query GwpAppV1GetDiscount($id: ID!) {
    discountNode(id: $id) { id }
  }
`;

const SET_METAFIELDS = `#graphql
  mutation GwpAppV1SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

// --------------------------------------------------------------------------
// Low-level helpers
// --------------------------------------------------------------------------

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const jsonResp = await response.json();
  if (jsonResp.errors?.length) {
    throw new Error(
      `GraphQL error: ${jsonResp.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return jsonResp.data;
}

function parseJsonMetafield(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function setMetafield(admin, { ownerId, namespace, key, value }) {
  const data = await gql(admin, SET_METAFIELDS, {
    metafields: [
      { ownerId, namespace, key, type: "json", value: JSON.stringify(value) },
    ],
  });
  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `metafieldsSet(${key}) failed: ${errors.map((e) => e.message).join(", ")}`,
    );
  }
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
      name: "Gift With Purchase configs",
      description:
        "List of Gift With Purchase configs read by the gift-with-purchase checkout extension via the storefront API.",
      ownerType: "SHOP",
      type: "json",
      access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" },
    },
  });
}

async function findFunctionId(admin) {
  const data = await gql(admin, LIST_FUNCTIONS);
  const nodes = data?.shopifyFunctions?.nodes ?? [];
  const discountNodes = nodes.filter(
    (n) => n.apiType === "discount" || n.apiType === "product_discounts",
  );
  const byTitle = discountNodes.find((n) => /gift|gwp|purchase/i.test(n.title ?? ""));
  return (byTitle ?? discountNodes[0])?.id ?? null;
}

// Ensure the automatic discount exists; create it if missing. Returns its id.
async function ensureDiscount(admin, { installationId, discountId, initialConfig }) {
  if (discountId) {
    try {
      const data = await gql(admin, GET_DISCOUNT, { id: discountId });
      if (data?.discountNode?.id) return discountId;
    } catch {
      // fall through and recreate
    }
  }

  const functionId = await findFunctionId(admin);
  if (!functionId) {
    throw new Error(
      `No discount function found. Deploy the ${FUNCTION_HANDLE} extension first.`,
    );
  }

  const data = await gql(admin, DISCOUNT_CREATE, {
    discount: {
      title: DISCOUNT_TITLE,
      functionId,
      discountClasses: ["PRODUCT"],
      combinesWith: {
        orderDiscounts: true,
        productDiscounts: true,
        shippingDiscounts: true,
      },
      metafields: [
        {
          namespace: FUNCTION_METAFIELD_NAMESPACE,
          key: FUNCTION_METAFIELD_KEY,
          type: "json",
          value: JSON.stringify(initialConfig),
        },
      ],
    },
  });
  const errors = data?.discountAutomaticAppCreate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `discountAutomaticAppCreate failed: ${errors.map((e) => e.message).join(", ")}`,
    );
  }
  const newId = data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
  if (!newId) throw new Error("discountAutomaticAppCreate returned no id");

  await setMetafield(admin, {
    ownerId: installationId,
    namespace: FUNCTION_METAFIELD_NAMESPACE,
    key: DISCOUNT_ID_KEY,
    value: newId,
  });
  return newId;
}

// --------------------------------------------------------------------------
// Public API used by the route
// --------------------------------------------------------------------------

// Read every saved config for the shop and push the full set to the shop
// metafield (checkout extension) and the discount metafield (function). Ensures
// the shop metafield definition and the automatic discount both exist.
export async function syncConfigs(admin, shop) {
  await ensureShopMetafieldDefinition(admin);

  const rows = await prisma.gwpAppV1Config.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  const configs = rows
    .map((row) => {
      try {
        return JSON.parse(row.configJson);
      } catch {
        return null;
      }
    })
    .filter((c) => c != null && typeof c === "object");

  const ctx = await gql(admin, GET_CONTEXT);
  const installationId = ctx?.currentAppInstallation?.id ?? null;
  const shopId = ctx?.shop?.id ?? null;
  const discountId = parseJsonMetafield(
    ctx?.currentAppInstallation?.discountId?.value,
    null,
  );
  if (!shopId) throw new Error("Could not resolve shop id");

  // 1. Shop metafield (rich configs) for the checkout extension.
  await setMetafield(admin, {
    ownerId: shopId,
    namespace: SHOP_METAFIELD_NAMESPACE,
    key: SHOP_METAFIELD_KEY,
    value: { configs },
  });

  // 2. Slim configs for the discount function.
  const functionConfigs = buildFunctionConfigs(configs);
  const functionPayload = { configs: functionConfigs };

  // Only manage the discount if there is at least one offer that can discount a
  // gift line; otherwise skip creating an empty discount on first save.
  if (installationId && (functionConfigs.length > 0 || discountId)) {
    const ensuredId = await ensureDiscount(admin, {
      installationId,
      discountId,
      initialConfig: functionPayload,
    });
    await setMetafield(admin, {
      ownerId: ensuredId,
      namespace: FUNCTION_METAFIELD_NAMESPACE,
      key: FUNCTION_METAFIELD_KEY,
      value: functionPayload,
    });
  }

  return { count: configs.length, functionCount: functionConfigs.length };
}
