// Server helpers for the "Toy purchase-with-purchase" promo.
//
// Two extensions consume one config object:
//   - the `toy-pwp-discount` Shopify Function reads it from the discount's
//     `$app/function-configuration` metafield and applies the % off the toy.
//   - the `limited-offer` checkout UI reads it from the Shop's
//     `$app/limited_offer_config` metafield and renders the progress bar.
//
// This module keeps both in sync. Activating a week writes the same JSON to
// both places. The 5-week schedule itself lives on the app installation.

import {
  DEFAULT_PERCENTAGE,
  DEFAULT_THRESHOLDS,
  SUPPORTED_CURRENCIES,
  WEEK_COUNT,
  defaultSchedule,
  toProductGid,
} from "./limitedOffer.shared";

const NAMESPACE = "$app";
const FUNCTION_CONFIG_KEY = "function-configuration"; // on the discount node
const SHOP_CONFIG_KEY = "limited_offer_config"; // on the Shop (read by checkout)
const SCHEDULE_KEY = "limited_offer_schedule"; // on the app installation
const DISCOUNT_ID_KEY = "limited_offer_discount_id"; // on the app installation

const DISCOUNT_TITLE = "Toy purchase-with-purchase";
const FUNCTION_HANDLE = "toy-pwp-discount";

// --------------------------------------------------------------------------
// GraphQL documents
// --------------------------------------------------------------------------

const GET_INSTALLATION = `#graphql
  query GetInstallation {
    currentAppInstallation {
      id
      schedule: metafield(namespace: "$app", key: "limited_offer_schedule") { value }
      discountId: metafield(namespace: "$app", key: "limited_offer_discount_id") { value }
    }
    shop { id }
  }
`;

const LIST_FUNCTIONS = `#graphql
  query ListFunctions {
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

const GET_PRODUCT = `#graphql
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      title
      status
      variants(first: 1) { nodes { id } }
      featuredMedia { preview { image { url } } }
    }
  }
`;

const DISCOUNT_CREATE = `#graphql
  mutation DiscountCreate($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const GET_DISCOUNT = `#graphql
  query GetDiscount($id: ID!) {
    discountNode(id: $id) {
      id
      discount {
        ... on DiscountAutomaticApp {
          title
          status
        }
      }
    }
  }
`;

const SET_METAFIELDS = `#graphql
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

// --------------------------------------------------------------------------
// Low-level helpers
// --------------------------------------------------------------------------

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, variables ? {variables} : undefined);
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(
      `GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return json.data;
}

function parseJsonMetafield(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function setMetafield(admin, {ownerId, key, value}) {
  const data = await gql(admin, SET_METAFIELDS, {
    metafields: [
      {ownerId, namespace: NAMESPACE, key, type: "json", value: JSON.stringify(value)},
    ],
  });
  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `metafieldsSet(${key}) failed: ${errors.map((e) => e.message).join(", ")}`,
    );
  }
}

async function getInstallation(admin) {
  const data = await gql(admin, GET_INSTALLATION);
  const installation = data?.currentAppInstallation ?? null;
  const shopId = data?.shop?.id ?? null;
  const schedule = parseJsonMetafield(
    installation?.schedule?.value,
    defaultSchedule(),
  );
  // Defensive: make sure the shape is always complete.
  const merged = {
    ...defaultSchedule(),
    ...schedule,
    thresholds: {...DEFAULT_THRESHOLDS, ...(schedule.thresholds ?? {})},
  };
  if (!Array.isArray(merged.weeks) || merged.weeks.length !== WEEK_COUNT) {
    merged.weeks = defaultSchedule().weeks;
  }
  const discountId = parseJsonMetafield(installation?.discountId?.value, null);
  return {installationId: installation?.id ?? null, shopId, schedule: merged, discountId};
}

export async function findFunctionId(admin) {
  const data = await gql(admin, LIST_FUNCTIONS);
  const nodes = data?.shopifyFunctions?.nodes ?? [];
  const discountNodes = nodes.filter(
    (n) => n.apiType === "discount" || n.apiType === "product_discounts",
  );
  // Prefer the one whose title clearly matches this extension.
  const byTitle = discountNodes.find((n) =>
    /toy|purchase-with-purchase|pwp/i.test(n.title ?? ""),
  );
  return (byTitle ?? discountNodes[0])?.id ?? null;
}

async function resolveProduct(admin, productGid) {
  const data = await gql(admin, GET_PRODUCT, {id: productGid});
  const product = data?.product;
  if (!product) {
    throw new Error(`Product not found: ${productGid}`);
  }
  const variantId = product.variants?.nodes?.[0]?.id ?? null;
  if (!variantId) {
    throw new Error(`Product has no variants: ${product.title}`);
  }
  return {
    productId: product.id,
    title: product.title,
    status: product.status,
    variantId,
    imageUrl: product.featuredMedia?.preview?.image?.url ?? null,
  };
}

// Build the single config object both extensions consume.
function buildConfig({schedule, week, product, enabled = true}) {
  const percentage = Number(schedule.discountPercentage) || DEFAULT_PERCENTAGE;
  return {
    enabled,
    discountPercentage: percentage,
    thresholds: schedule.thresholds,
    productId: product.productId,
    variantIds: [product.variantId],
    message: `${percentage}% off ${product.title}`,
    week,
    product: {
      title: product.title,
      productId: product.productId,
      variantId: product.variantId,
    },
  };
}

// --------------------------------------------------------------------------
// Public API used by the route
// --------------------------------------------------------------------------

export async function getState(admin) {
  const [{installationId, shopId, schedule, discountId}, functionId] =
    await Promise.all([getInstallation(admin), findFunctionId(admin)]);

  let discountStatus = null;
  if (discountId) {
    try {
      const data = await gql(admin, GET_DISCOUNT, {id: discountId});
      discountStatus = data?.discountNode?.discount?.status ?? null;
    } catch {
      discountStatus = null;
    }
  }

  return {
    installationId,
    shopId,
    schedule,
    discountId,
    discountStatus,
    functionId,
    functionFound: Boolean(functionId),
  };
}

export async function saveSchedule(admin, schedule) {
  const {installationId} = await getInstallation(admin);
  if (!installationId) throw new Error("Could not load app installation");

  const clean = {
    ...defaultSchedule(),
    ...schedule,
    discountPercentage: Number(schedule.discountPercentage) || DEFAULT_PERCENTAGE,
    thresholds: SUPPORTED_CURRENCIES.reduce((acc, code) => {
      const raw = Number(schedule.thresholds?.[code]);
      acc[code] = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLDS[code];
      return acc;
    }, {}),
    weeks: (schedule.weeks ?? []).slice(0, WEEK_COUNT).map((w, i) => ({
      week: i + 1,
      productId: toProductGid(w.productId) ?? "",
      title: w.title ?? "",
      note: w.note ?? "",
    })),
  };

  await setMetafield(admin, {
    ownerId: installationId,
    key: SCHEDULE_KEY,
    value: clean,
  });
  return {schedule: clean};
}

// Ensure the automatic discount exists; create it if missing. Returns the id.
async function ensureDiscount(admin, {installationId, functionId, initialConfig}) {
  const {discountId} = await getInstallation(admin);
  if (discountId) {
    // Verify it still exists server-side; if not, fall through and recreate.
    try {
      const data = await gql(admin, GET_DISCOUNT, {id: discountId});
      if (data?.discountNode?.id) return discountId;
    } catch {
      // recreate below
    }
  }

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
          namespace: NAMESPACE,
          key: FUNCTION_CONFIG_KEY,
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
    key: DISCOUNT_ID_KEY,
    value: newId,
  });
  return newId;
}

// Activate a given week: resolve the toy, write config to discount + shop.
export async function activateWeek(admin, weekNumber) {
  const {installationId, shopId, schedule} = await getInstallation(admin);
  if (!installationId || !shopId) {
    throw new Error("Could not load app installation / shop");
  }
  const functionId = await findFunctionId(admin);

  const week = schedule.weeks.find((w) => w.week === Number(weekNumber));
  if (!week) throw new Error(`Week ${weekNumber} not found in schedule`);
  const productGid = toProductGid(week.productId);
  if (!productGid) {
    throw new Error(`Week ${weekNumber} has no product set`);
  }

  const product = await resolveProduct(admin, productGid);
  const config = buildConfig({schedule, week: Number(weekNumber), product, enabled: true});

  // 1. Make sure the discount exists (seeded with this config).
  const discountId = await ensureDiscount(admin, {
    installationId,
    functionId,
    initialConfig: config,
  });

  // 2. Update the discount's config (covers the already-existed case).
  await setMetafield(admin, {ownerId: discountId, key: FUNCTION_CONFIG_KEY, value: config});

  // 3. Update the shop config the checkout UI reads.
  await setMetafield(admin, {ownerId: shopId, key: SHOP_CONFIG_KEY, value: config});

  // 4. Record + persist resolved title back onto the schedule for display.
  const nextWeeks = schedule.weeks.map((w) =>
    w.week === Number(weekNumber) ? {...w, title: product.title} : w,
  );
  await setMetafield(admin, {
    ownerId: installationId,
    key: SCHEDULE_KEY,
    value: {...schedule, weeks: nextWeeks, activeWeek: Number(weekNumber), enabled: true},
  });

  return {discountId, activeWeek: Number(weekNumber), product, config};
}

// Pause the promo: flip enabled=false everywhere (keeps schedule intact).
export async function setEnabled(admin, enabled) {
  const {installationId, shopId, schedule, discountId} = await getInstallation(admin);
  if (!installationId || !shopId) {
    throw new Error("Could not load app installation / shop");
  }

  // Update shop + discount configs if a week is active.
  if (schedule.activeWeek && discountId) {
    const week = schedule.weeks.find((w) => w.week === schedule.activeWeek);
    const productGid = toProductGid(week?.productId);
    if (productGid) {
      const product = await resolveProduct(admin, productGid);
      const config = buildConfig({
        schedule,
        week: schedule.activeWeek,
        product,
        enabled,
      });
      await setMetafield(admin, {ownerId: discountId, key: FUNCTION_CONFIG_KEY, value: config});
      await setMetafield(admin, {ownerId: shopId, key: SHOP_CONFIG_KEY, value: config});
    }
  }

  await setMetafield(admin, {
    ownerId: installationId,
    key: SCHEDULE_KEY,
    value: {...schedule, enabled},
  });

  return {enabled};
}
