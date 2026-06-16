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
// A single automatic app discount is created on demand and bound to the function.

import prisma from "../db.server";
import {
  FUNCTION_METAFIELD_KEY,
  FUNCTION_METAFIELD_NAMESPACE,
  SHOP_METAFIELD_KEY,
  SHOP_METAFIELD_NAMESPACE,
  buildFunctionConfigs,
} from "./gwpAppV1.shared";

const DISCOUNT_TITLE = "Gift with purchase";
// Tag applied to the automatic discount this app creates, so app-managed
// discounts are identifiable in the admin Discounts list.
const DISCOUNT_TAGS = ["AMD App"];
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

const TAGS_ADD = `#graphql
  mutation GwpAppV1TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const GET_DISCOUNT_STATUS = `#graphql
  query GwpAppV1DiscountStatus($id: ID!) {
    discountNode(id: $id) {
      id
      discount {
        __typename
        ... on DiscountAutomaticApp {
          title
          status
          startsAt
          endsAt
        }
      }
    }
  }
`;

const DISCOUNT_ACTIVATE = `#graphql
  mutation GwpAppV1DiscountActivate($id: ID!) {
    discountAutomaticActivate(id: $id) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }
`;

const DISCOUNT_DEACTIVATE = `#graphql
  mutation GwpAppV1DiscountDeactivate($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
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
// `activateOnCreate` sets the initial state when a discount is freshly created:
// false (no live config) creates it deactivated. It only applies on creation -
// an existing discount's state is left as-is so manual activate/deactivate wins.
async function ensureDiscount(
  admin,
  { installationId, discountId, initialConfig, activateOnCreate = true },
) {
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

  // Tag the new discount so it's identifiable in the admin. Non-fatal: a tagging
  // failure must not block discount creation or config sync.
  try {
    const tagData = await gql(admin, TAGS_ADD, { id: newId, tags: DISCOUNT_TAGS });
    const tagErrors = tagData?.tagsAdd?.userErrors ?? [];
    if (tagErrors.length) {
      console.error(
        `tagsAdd on GWP discount failed: ${tagErrors.map((e) => e.message).join(", ")}`,
      );
    }
  } catch (err) {
    console.error("tagsAdd on GWP discount threw", err);
  }

  await setMetafield(admin, {
    ownerId: installationId,
    namespace: FUNCTION_METAFIELD_NAMESPACE,
    key: DISCOUNT_ID_KEY,
    value: newId,
  });

  // New discounts are created active. If there's no live offer (e.g. all test
  // mode), deactivate it so nothing applies on real checkouts until the merchant
  // turns it on. Non-fatal.
  if (!activateOnCreate) {
    try {
      await gql(admin, DISCOUNT_DEACTIVATE, { id: newId });
    } catch (err) {
      console.error("Deactivating new GWP discount failed", err);
    }
  }

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

  // If the discount is created on this sync, start it active only when there's a
  // live (non-test) enabled offer; an all-test setup is created deactivated.
  const anyLiveEnabled = configs.some(
    (c) =>
      c &&
      c.enabled !== false &&
      String(c.mode || "live").toLowerCase() !== "test",
  );

  // Only manage the discount if there is at least one offer that can discount a
  // gift line; otherwise skip creating an empty discount on first save.
  if (installationId && (functionConfigs.length > 0 || discountId)) {
    const ensuredId = await ensureDiscount(admin, {
      installationId,
      discountId,
      initialConfig: functionPayload,
      activateOnCreate: anyLiveEnabled,
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

// Resolve the stored discount id (a gid) from the app installation metafield.
async function resolveDiscountId(admin) {
  const ctx = await gql(admin, GET_CONTEXT);
  return parseJsonMetafield(ctx?.currentAppInstallation?.discountId?.value, null);
}

// Fetch the current state of the app's automatic discount for the Discount
// section in the UI. Returns { exists: false } when no discount has been
// created yet, otherwise its id, status, title and an admin deep link.
export async function getDiscountInfo(admin, shop) {
  const discountId = await resolveDiscountId(admin);
  if (!discountId) return { exists: false };

  let node;
  try {
    const data = await gql(admin, GET_DISCOUNT_STATUS, { id: discountId });
    node = data?.discountNode;
  } catch {
    return { exists: false };
  }
  if (!node?.id) return { exists: false };

  const discount = node.discount ?? {};
  const numericId = String(discountId).match(/\/(\d+)$/)?.[1] ?? null;
  const adminUrl =
    shop && numericId ? `https://${shop}/admin/discounts/${numericId}` : null;

  return {
    exists: true,
    id: discountId,
    status: discount.status ?? null, // ACTIVE | EXPIRED | SCHEDULED
    title: discount.title ?? DISCOUNT_TITLE,
    startsAt: discount.startsAt ?? null,
    endsAt: discount.endsAt ?? null,
    adminUrl,
  };
}

// Activate or deactivate the app's automatic discount. Manual override that the
// merchant triggers from the Discount section; wins over the mode-based default.
export async function setDiscountActive(admin, active) {
  const discountId = await resolveDiscountId(admin);
  if (!discountId) {
    throw new Error("No discount exists yet. Save a config to create it first.");
  }
  const mutation = active ? DISCOUNT_ACTIVATE : DISCOUNT_DEACTIVATE;
  const key = active ? "discountAutomaticActivate" : "discountAutomaticDeactivate";
  const data = await gql(admin, mutation, { id: discountId });
  const errors = data?.[key]?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `${key} failed: ${errors.map((e) => e.message).join(", ")}`,
    );
  }
  return discountId;
}
