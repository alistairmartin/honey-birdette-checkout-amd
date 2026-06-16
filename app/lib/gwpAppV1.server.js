// Server helpers for the "Gift With Purchase" multi-offer system.
//
// The admin builder page (app.gift-with-purchase.jsx) saves each offer as a
// GwpAppV1Config row. On every change it calls syncConfigs(), which:
//   - pushes the full config set to the SHOP metafield
//     ($app:gift-with-purchase / configs) read by the gift-with-purchase
//     checkout extension via the storefront API; and
//   - manages ONE automatic app discount per config (stored on the row's
//     discountId). Each discount is bound to the gift-with-purchase-discount
//     Shopify Function and carries that single config's slim payload in its
//     $app/function-configuration metafield. The config's enabled/mode state
//     maps to the discount being active or deactivated.
//
// A legacy single shared discount (stored on the app installation metafield) is
// retired on the first sync after this change.

import prisma from "../db.server";
import {
  FUNCTION_METAFIELD_KEY,
  FUNCTION_METAFIELD_NAMESPACE,
  SHOP_METAFIELD_KEY,
  SHOP_METAFIELD_NAMESPACE,
  buildFunctionConfig,
} from "./gwpAppV1.shared";

const DISCOUNT_TITLE = "Gift with purchase";
// Tag applied to the automatic discounts this app creates, so app-managed
// discounts are identifiable in the admin Discounts list.
const DISCOUNT_TAGS = ["AMD App"];
const FUNCTION_HANDLE = "gift-with-purchase-discount";
const DISCOUNT_ID_KEY = "gwp_app_v1_discount_id"; // legacy shared discount id

// Discount title for a config: explicit discount_title, else the row name, else
// a sensible default.
function discountTitleFor(config, row) {
  const explicit = String(config?.discount_title || "").trim();
  if (explicit) return explicit;
  const name = String(row?.name || "").trim();
  return name || DISCOUNT_TITLE;
}

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

const DISCOUNT_UPDATE = `#graphql
  mutation GwpAppV1DiscountUpdate($id: ID!, $discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
      userErrors { field message }
    }
  }
`;

const DISCOUNT_DELETE = `#graphql
  mutation GwpAppV1DiscountDelete($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field message }
    }
  }
`;

const GET_DISCOUNTS_STATUS = `#graphql
  query GwpAppV1DiscountsStatus($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on DiscountNode {
        id
        discount {
          __typename
          ... on DiscountAutomaticApp {
            title
            status
          }
        }
      }
    }
  }
`;

const TAGS_ADD = `#graphql
  mutation GwpAppV1TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
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

// Create a new automatic app discount bound to the function, carrying one
// config's slim payload, with the given title. Created active unless `active`
// is false. Returns the new discount gid.
async function createDiscount(admin, { functionId, title, payload, active }) {
  const data = await gql(admin, DISCOUNT_CREATE, {
    discount: {
      title,
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
          value: JSON.stringify(payload),
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

  // Tag the new discount so it's identifiable in the admin. Non-fatal.
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

  // Discounts are created active; deactivate when the config isn't a live offer.
  if (!active) {
    try {
      await gql(admin, DISCOUNT_DEACTIVATE, { id: newId });
    } catch (err) {
      console.error("Deactivating new GWP discount failed", err);
    }
  }

  return newId;
}

async function discountExists(admin, discountId) {
  if (!discountId) return false;
  try {
    const data = await gql(admin, GET_DISCOUNT, { id: discountId });
    return Boolean(data?.discountNode?.id);
  } catch {
    return false;
  }
}

async function deleteDiscount(admin, discountId) {
  if (!discountId) return;
  try {
    await gql(admin, DISCOUNT_DELETE, { id: discountId });
  } catch (err) {
    console.error("Deleting GWP discount failed", err);
  }
}

// Bring one config's discount in line with the config: create it if missing,
// keep its title + function payload current, and (only on creation) set the
// active state from enabled/mode. A disabled config is always deactivated.
// Returns the discount gid, or null when the config has no gift product.
async function ensureConfigDiscount(admin, { functionId, row, config }) {
  const fnConfig = buildFunctionConfig(config);
  if (!fnConfig) {
    // No gift product to target. Retire any discount the config used to own.
    if (row.discountId) {
      await deleteDiscount(admin, row.discountId);
      await prisma.gwpAppV1Config.update({
        where: { id: row.id },
        data: { discountId: null },
      });
    }
    return null;
  }

  const payload = { configs: [fnConfig] };
  const title = discountTitleFor(config, row);
  const isEnabled = config.enabled !== false;
  const isLive = String(config.mode || "live").toLowerCase() !== "test";

  let discountId = row.discountId;
  const exists = await discountExists(admin, discountId);

  if (!exists) {
    // Fresh discount. Active only when the config is enabled AND live.
    discountId = await createDiscount(admin, {
      functionId,
      title,
      payload,
      active: isEnabled && isLive,
    });
    await prisma.gwpAppV1Config.update({
      where: { id: row.id },
      data: { discountId },
    });
    return discountId;
  }

  // Existing discount: keep title + payload current. The active state is left to
  // the merchant (manual override) except a disabled config is forced off.
  try {
    await gql(admin, DISCOUNT_UPDATE, { id: discountId, discount: { title } });
  } catch (err) {
    console.error("Updating GWP discount title failed", err);
  }
  await setMetafield(admin, {
    ownerId: discountId,
    namespace: FUNCTION_METAFIELD_NAMESPACE,
    key: FUNCTION_METAFIELD_KEY,
    value: payload,
  });
  if (!isEnabled) {
    try {
      await gql(admin, DISCOUNT_DEACTIVATE, { id: discountId });
    } catch (err) {
      console.error("Deactivating disabled GWP discount failed", err);
    }
  }
  return discountId;
}

// One-time migration: delete the legacy single shared discount (stored on the
// app installation metafield) and clear the pointer so it isn't retried.
async function retireLegacyDiscount(admin, installationId, legacyDiscountId) {
  if (!installationId || !legacyDiscountId) return;
  await deleteDiscount(admin, legacyDiscountId);
  try {
    await setMetafield(admin, {
      ownerId: installationId,
      namespace: FUNCTION_METAFIELD_NAMESPACE,
      key: DISCOUNT_ID_KEY,
      value: null,
    });
  } catch (err) {
    console.error("Clearing legacy GWP discount pointer failed", err);
  }
}

// --------------------------------------------------------------------------
// Public API used by the route
// --------------------------------------------------------------------------

// Push the full config set to the shop metafield (checkout extension) and bring
// every config's own discount in line (create/update/deactivate). Retires the
// legacy shared discount on first run. Runs on every load and after every save.
export async function syncConfigs(admin, shop) {
  await ensureShopMetafieldDefinition(admin);

  const rows = await prisma.gwpAppV1Config.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  const parsed = rows.map((row) => {
    let config = null;
    try {
      config = JSON.parse(row.configJson);
    } catch {
      config = null;
    }
    return { row, config };
  });
  const configs = parsed
    .map((p) => p.config)
    .filter((c) => c != null && typeof c === "object");

  const ctx = await gql(admin, GET_CONTEXT);
  const installationId = ctx?.currentAppInstallation?.id ?? null;
  const shopId = ctx?.shop?.id ?? null;
  const legacyDiscountId = parseJsonMetafield(
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

  // 2. Retire the legacy single shared discount, if it still exists.
  await retireLegacyDiscount(admin, installationId, legacyDiscountId);

  // 3. One discount per config. Look up the function once, only if needed.
  const needsFunction = parsed.some(
    ({ config }) => config && buildFunctionConfig(config),
  );
  let functionId = null;
  if (needsFunction) {
    functionId = await findFunctionId(admin);
    if (!functionId) {
      throw new Error(
        `No discount function found. Deploy the ${FUNCTION_HANDLE} extension first.`,
      );
    }
  }

  let discountCount = 0;
  for (const { row, config } of parsed) {
    if (!config) continue;
    const id = await ensureConfigDiscount(admin, { functionId, row, config });
    if (id) discountCount += 1;
  }

  return { count: configs.length, discountCount };
}

// Build a map of configId -> { exists, status, title, adminUrl, discountId } for
// the saved-config cards. Batches all discount lookups into one query.
export async function getConfigDiscountMap(admin, shop, rows) {
  const map = {};
  for (const r of rows) {
    map[r.id] = { exists: false, discountId: r.discountId || null };
  }
  const withId = rows.filter((r) => r.discountId);
  if (!withId.length) return map;

  let nodes = [];
  try {
    const data = await gql(admin, GET_DISCOUNTS_STATUS, {
      ids: withId.map((r) => r.discountId),
    });
    nodes = data?.nodes ?? [];
  } catch {
    return map;
  }
  const byId = {};
  for (const n of nodes) {
    if (n?.id) byId[n.id] = n;
  }
  for (const r of withId) {
    const node = byId[r.discountId];
    if (!node) continue; // discount was deleted out from under us
    const discount = node.discount ?? {};
    const numericId = String(r.discountId).match(/\/(\d+)$/)?.[1] ?? null;
    map[r.id] = {
      exists: true,
      discountId: r.discountId,
      status: discount.status ?? null, // ACTIVE | EXPIRED | SCHEDULED
      title: discount.title ?? null,
      adminUrl:
        shop && numericId
          ? `https://${shop}/admin/discounts/${numericId}`
          : null,
    };
  }
  return map;
}

// Activate or deactivate a single config's discount (manual override from the
// config card). Returns the discount gid.
export async function setConfigDiscountActive(admin, shop, configId, active) {
  const row = await prisma.gwpAppV1Config.findFirst({
    where: { id: configId, shop },
  });
  if (!row?.discountId) {
    throw new Error("This config has no discount yet - create it first.");
  }
  const mutation = active ? DISCOUNT_ACTIVATE : DISCOUNT_DEACTIVATE;
  const key = active ? "discountAutomaticActivate" : "discountAutomaticDeactivate";
  const data = await gql(admin, mutation, { id: row.discountId });
  const errors = data?.[key]?.userErrors ?? [];
  if (errors.length) {
    throw new Error(`${key} failed: ${errors.map((e) => e.message).join(", ")}`);
  }
  return row.discountId;
}

// Create (or re-ensure) a single config's discount on demand from its card.
export async function createConfigDiscount(admin, shop, configId) {
  const row = await prisma.gwpAppV1Config.findFirst({
    where: { id: configId, shop },
  });
  if (!row) throw new Error("Config not found.");
  let config = null;
  try {
    config = JSON.parse(row.configJson);
  } catch {
    config = null;
  }
  if (!config || !buildFunctionConfig(config)) {
    throw new Error("Add a gift product to this config before creating a discount.");
  }
  const functionId = await findFunctionId(admin);
  if (!functionId) {
    throw new Error(
      `No discount function found. Deploy the ${FUNCTION_HANDLE} extension first.`,
    );
  }
  return ensureConfigDiscount(admin, { functionId, row, config });
}

// Delete a config's discount. Call before deleting the config row.
export async function deleteConfigDiscount(admin, discountId) {
  await deleteDiscount(admin, discountId);
}
