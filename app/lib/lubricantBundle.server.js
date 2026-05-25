export const METAOBJECT_TYPE = "lubricant_bundle";
export const FUNCTION_CONFIG_NAMESPACE = "$app";
export const FUNCTION_CONFIG_KEY = "function-configuration";
export const CART_TRANSFORM_FUNCTION_HANDLE = "lubricant-bundle-transform";
export const CART_TRANSFORM_ID_KEY = "cart_transform_id";
export const BUNDLE_INDEX_KEY = "bundle-index";
export const SUPPORTED_CURRENCIES = [
  "AUD",
  "NZD",
  "USD",
  "CAD",
  "EUR",
  "GBP",
  "AED",
];

const moneyFieldKey = (code) => `discount_${code.toLowerCase()}`;

const emptyDiscountAmounts = () =>
  SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = 0;
    return acc;
  }, {});

// --------------------------------------------------------------------------
// Metaobject fetch + flatten
// --------------------------------------------------------------------------

const GET_BUNDLE_QUERY = `#graphql
  query GetBundle($id: ID!) {
    metaobject(id: $id) {
      id
      displayName
      type
      fields {
        key
        value
        references(first: 100) {
          nodes {
            ... on Product {
              id
              title
              variants(first: 1) { nodes { id } }
            }
          }
        }
      }
    }
  }
`;

const LIST_BUNDLES_QUERY = `#graphql
  query ListBundles($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        displayName
        type
        fields {
          key
          value
          references(first: 100) {
            nodes {
              ... on Product {
                id
                title
                variants(first: 1) { nodes { id } }
              }
            }
          }
        }
      }
    }
  }
`;

export function flattenMetaobject(metaobject) {
  const fieldByKey = new Map();
  for (const f of metaobject.fields ?? []) {
    fieldByKey.set(f.key, f);
  }

  const refNodes = (key) =>
    fieldByKey.get(key)?.references?.nodes ?? [];

  const refIds = (key) => refNodes(key).map((n) => n?.id).filter(Boolean);
  const refTitles = (key) =>
    refNodes(key).map((n) => n?.title).filter(Boolean);

  const discountAmounts = emptyDiscountAmounts();
  for (const code of SUPPORTED_CURRENCIES) {
    const f = fieldByKey.get(moneyFieldKey(code));
    if (!f?.value) continue;
    try {
      const parsed = JSON.parse(f.value);
      discountAmounts[code] = Number(parsed.amount ?? 0);
    } catch {
      // ignore malformed money values
    }
  }

  const parentProduct = refNodes("parent_product")[0];
  const parentVariantId = parentProduct?.variants?.nodes?.[0]?.id ?? null;

  return {
    id: metaobject.id,
    name: metaobject.displayName ?? "",
    productIds: refIds("products"),
    productTitles: refTitles("products"),
    option1Ids: refIds("option_1"),
    option1Titles: refTitles("option_1"),
    option2Ids: refIds("option_2"),
    option2Titles: refTitles("option_2"),
    parentProductId: parentProduct?.id ?? null,
    parentProductTitle: parentProduct?.title ?? null,
    parentVariantId,
    discountAmounts,
  };
}

async function fetchMetaobject(admin, id) {
  const response = await admin.graphql(GET_BUNDLE_QUERY, {variables: {id}});
  const json = await response.json();
  return json?.data?.metaobject ?? null;
}

async function fetchAllBundles(admin) {
  const flattened = [];
  let cursor = null;
  while (true) {
    const response = await admin.graphql(LIST_BUNDLES_QUERY, {
      variables: {type: METAOBJECT_TYPE, cursor},
    });
    const json = await response.json();
    const page = json?.data?.metaobjects;
    if (!page) break;
    for (const node of page.nodes ?? []) {
      flattened.push(flattenMetaobject(node));
    }
    if (!page.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return flattened;
}

// --------------------------------------------------------------------------
// Discount metafield sync (per bundle change)
// --------------------------------------------------------------------------

const LIST_DISCOUNTS_QUERY = `#graphql
  query DiscountsWithFunctionConfig($cursor: String) {
    discountNodes(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        metafield(namespace: "$app", key: "function-configuration") {
          id
          value
        }
      }
    }
  }
`;

const SET_METAFIELD_MUTATION = `#graphql
  mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

async function listAllDiscounts(admin) {
  const results = [];
  let cursor = null;
  while (true) {
    const response = await admin.graphql(LIST_DISCOUNTS_QUERY, {
      variables: {cursor},
    });
    const json = await response.json();
    const page = json?.data?.discountNodes;
    if (!page) break;
    for (const node of page.nodes ?? []) {
      if (node?.metafield?.value) results.push(node);
    }
    if (!page.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return results;
}

async function setMetafield(admin, {ownerId, namespace, key, value}) {
  const response = await admin.graphql(SET_METAFIELD_MUTATION, {
    variables: {
      metafields: [
        {ownerId, namespace, key, type: "json", value: JSON.stringify(value)},
      ],
    },
  });
  const json = await response.json();
  const errors = json?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `metafieldsSet failed: ${errors.map((e) => e.message).join(", ")}`,
    );
  }
}

function parseConfig(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return {
      bundleIds: Array.isArray(parsed.bundleIds) ? parsed.bundleIds : [],
      bundles: Array.isArray(parsed.bundles) ? parsed.bundles : [],
    };
  } catch {
    return {bundleIds: [], bundles: []};
  }
}

function metaobjectGidFromId(id) {
  const numeric = typeof id === "number" ? id : Number(id);
  if (!Number.isFinite(numeric)) {
    if (typeof id === "string" && id.startsWith("gid://")) return id;
    return null;
  }
  return `gid://shopify/Metaobject/${numeric}`;
}

export async function syncBundleAcrossDiscounts(admin, {payload, deleted}) {
  if (payload?.type !== METAOBJECT_TYPE) return {touched: 0};
  const targetGid = metaobjectGidFromId(payload.id);
  if (!targetGid) return {touched: 0};

  const refreshed = deleted ? null : await fetchMetaobject(admin, targetGid);
  if (!deleted && !refreshed) return {touched: 0};

  const flattened = refreshed ? flattenMetaobject(refreshed) : null;

  const discounts = await listAllDiscounts(admin);
  let touched = 0;

  for (const node of discounts) {
    const config = parseConfig(node.metafield?.value);
    if (!config.bundleIds.includes(targetGid)) continue;

    let nextBundleIds;
    let nextBundles;
    if (deleted) {
      nextBundleIds = config.bundleIds.filter((id) => id !== targetGid);
      nextBundles = config.bundles.filter((b) => b?.id !== targetGid);
    } else {
      nextBundleIds = config.bundleIds;
      const without = config.bundles.filter((b) => b?.id !== targetGid);
      nextBundles = [...without, flattened];
    }

    await setMetafield(admin, {
      ownerId: node.id,
      namespace: FUNCTION_CONFIG_NAMESPACE,
      key: FUNCTION_CONFIG_KEY,
      value: {bundleIds: nextBundleIds, bundles: nextBundles},
    });
    touched++;
  }

  return {touched};
}

// --------------------------------------------------------------------------
// Cart transform: install + bundle-index sync
// --------------------------------------------------------------------------

const GET_APP_INSTALLATION = `#graphql
  query GetAppInstallation {
    currentAppInstallation {
      id
      metafield(namespace: "$app", key: "cart_transform_id") {
        value
      }
    }
  }
`;

const LIST_SHOPIFY_FUNCTIONS = `#graphql
  query ListShopifyFunctions {
    shopifyFunctions(first: 100) {
      nodes {
        id
        apiType
        title
        app { title }
      }
    }
  }
`;

const CART_TRANSFORM_CREATE = `#graphql
  mutation CartTransformCreate($functionId: String!) {
    cartTransformCreate(functionId: $functionId, blockOnFailure: false) {
      cartTransform { id }
      userErrors { field message }
    }
  }
`;

async function getAppInstallation(admin) {
  const response = await admin.graphql(GET_APP_INSTALLATION);
  const json = await response.json();
  return json?.data?.currentAppInstallation ?? null;
}

async function findCartTransformFunctionId(admin) {
  const response = await admin.graphql(LIST_SHOPIFY_FUNCTIONS);
  const json = await response.json();
  const nodes = json?.data?.shopifyFunctions?.nodes ?? [];
  const match = nodes.find((n) => n.apiType === "cart_transform");
  return match?.id ?? null;
}

export async function getCartTransformId(admin) {
  const installation = await getAppInstallation(admin);
  return installation?.metafield?.value ?? null;
}

export async function installCartTransform(admin) {
  const existing = await getCartTransformId(admin);
  if (existing) {
    return {cartTransformId: existing, created: false};
  }

  const functionId = await findCartTransformFunctionId(admin);
  if (!functionId) {
    throw new Error(
      "No cart_transform function found. Deploy the lubricant-bundle-transform extension first.",
    );
  }

  const response = await admin.graphql(CART_TRANSFORM_CREATE, {
    variables: {functionId},
  });
  const json = await response.json();
  const errors = json?.data?.cartTransformCreate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `cartTransformCreate failed: ${errors
        .map((e) => e.message)
        .join(", ")}`,
    );
  }
  const cartTransformId = json?.data?.cartTransformCreate?.cartTransform?.id;
  if (!cartTransformId) {
    throw new Error("cartTransformCreate returned no cartTransform id");
  }

  const installation = await getAppInstallation(admin);
  if (!installation?.id) {
    throw new Error("Could not load currentAppInstallation");
  }

  await setMetafield(admin, {
    ownerId: installation.id,
    namespace: FUNCTION_CONFIG_NAMESPACE,
    key: CART_TRANSFORM_ID_KEY,
    value: cartTransformId,
  });

  return {cartTransformId, created: true};
}

export async function syncBundleIndexToCartTransform(admin) {
  const cartTransformId = await getCartTransformId(admin);
  if (!cartTransformId) {
    return {synced: false, reason: "cart transform not installed"};
  }

  const flattened = await fetchAllBundles(admin);
  const bundles = flattened
    .filter((b) => b.parentVariantId && b.productIds.length)
    .map((b) => ({
      id: b.id,
      name: b.name,
      parentVariantId: b.parentVariantId,
      productIds: b.productIds,
      option1Ids: b.option1Ids,
      option2Ids: b.option2Ids,
      discountAmounts: b.discountAmounts,
    }));

  await setMetafield(admin, {
    ownerId: cartTransformId,
    namespace: FUNCTION_CONFIG_NAMESPACE,
    key: BUNDLE_INDEX_KEY,
    value: {bundles},
  });

  return {synced: true, bundleCount: bundles.length, skipped: flattened.length - bundles.length};
}
