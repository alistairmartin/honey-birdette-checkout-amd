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

const LIST_SEGMENTS = `#graphql
  query GwpAppV1Segments {
    segments(first: 50) {
      nodes { id name }
    }
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

const GET_DISCOUNT_STATUS = `#graphql
  query GwpAppV1DiscountStatus($id: ID!) {
    discountNode(id: $id) {
      id
      discount {
        __typename
        ... on DiscountAutomaticApp {
          title
          status
          context {
            __typename
            ... on DiscountCustomers { customers { id } }
            ... on DiscountCustomerSegments { segments { id } }
          }
        }
      }
    }
  }
`;

const CUSTOMERS_BY_EMAIL = `#graphql
  query GwpAppV1CustomersByEmail($query: String!) {
    customers(first: 50, query: $query) {
      nodes { id email }
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

// Store timezone the config's valid-date/time fields are expressed in. Must match
// STORE_TIMEZONE in the gift-with-purchase checkout extension.
const STORE_TIMEZONE = "Australia/Melbourne";

// Offset (ms) of `timeZone` from UTC at the given UTC instant, DST-aware.
function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  const asUTC = Date.UTC(
    +map.year,
    +map.month - 1,
    +map.day,
    +map.hour % 24,
    +map.minute,
    +map.second,
  );
  return asUTC - utcMs;
}

// Interpret a "YYYY-MM-DD" date + optional "HH:MM" time as wall-clock in
// STORE_TIMEZONE and return the UTC ISO instant, or null if no date.
function storeLocalToISO(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, mo, d] = String(dateStr).split("-").map(Number);
  if (!y || !mo || !d) return null;
  const [hh = 0, mm = 0] = String(timeStr || "")
    .split(":")
    .map((n) => Number(n) || 0);
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  let utc = guess - tzOffsetMs(guess, STORE_TIMEZONE);
  // Re-resolve once in case the guess landed on the wrong side of a DST change.
  utc = guess - tzOffsetMs(utc, STORE_TIMEZONE);
  return new Date(utc).toISOString();
}

// Active window for the discount from the config's valid-date fields. startsAt
// is required by the API, so it defaults to now when the config has no start.
function discountDatesFor(config) {
  const startsAt =
    storeLocalToISO(config?.valid_date_from, config?.valid_time_from) ||
    new Date().toISOString();
  const endsAt =
    storeLocalToISO(config?.valid_date_till, config?.valid_time_till) || null;
  return { startsAt, endsAt };
}

// Which discount classes this config's discount may combine with, defaulting to
// none ("Can't combine") to match Shopify's own default.
function combinesWithFor(config) {
  const c = config?.combines_with || {};
  return {
    orderDiscounts: c.orderDiscounts === true,
    productDiscounts: c.productDiscounts === true,
    shippingDiscounts: c.shippingDiscounts === true,
  };
}

// Normalize the DiscountContext union returned by the API into a plain shape.
function normalizeContext(context) {
  const t = context?.__typename;
  if (t === "DiscountCustomers") {
    return {
      type: "customers",
      customerIds: (context.customers || []).map((c) => c.id),
      segmentIds: [],
    };
  }
  if (t === "DiscountCustomerSegments") {
    return {
      type: "segments",
      customerIds: [],
      segmentIds: (context.segments || []).map((s) => s.id),
    };
  }
  return { type: "all", customerIds: [], segmentIds: [] };
}

// Resolve a list of emails to customer gids (deduped, lowercased). Unknown
// emails are simply dropped.
async function resolveCustomerIds(admin, emails) {
  const clean = [
    ...new Set(
      (Array.isArray(emails) ? emails : [])
        .map((e) => String(e).trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!clean.length) return [];
  const query = clean.map((e) => `email:${e}`).join(" OR ");
  try {
    const data = await gql(admin, CUSTOMERS_BY_EMAIL, { query });
    return (data?.customers?.nodes || []).map((n) => n.id);
  } catch (err) {
    console.error("Resolving customer emails failed", err);
    return [];
  }
}

// Build the discount `context` input from a config, diffed against the current
// context so the result is declarative. Returns null to leave eligibility
// untouched (e.g. "specific" selected but nothing resolvable to set).
async function buildContextInput(admin, config, current) {
  const eligibility = String(config?.eligibility || "all");
  const cur = current || { type: "all", customerIds: [], segmentIds: [] };

  if (eligibility === "customers") {
    const desired = await resolveCustomerIds(admin, config.eligible_emails);
    if (!desired.length) return null; // can't set an empty specific-customer list
    const have = cur.type === "customers" ? cur.customerIds : [];
    return {
      customers: {
        add: desired.filter((id) => !have.includes(id)),
        remove: have.filter((id) => !desired.includes(id)),
      },
    };
  }

  if (eligibility === "segments") {
    const desired = Array.isArray(config.eligible_segment_ids)
      ? config.eligible_segment_ids
      : [];
    if (!desired.length) return null;
    const have = cur.type === "segments" ? cur.segmentIds : [];
    return {
      customerSegments: {
        add: desired.filter((id) => !have.includes(id)),
        remove: have.filter((id) => !desired.includes(id)),
      },
    };
  }

  return { all: "ALL" };
}

// Create a new automatic app discount bound to the function, carrying one
// config's slim payload, with the given title. Created active unless `active`
// is false. Returns the new discount gid.
async function createDiscount(
  admin,
  { functionId, title, payload, active, combinesWith, startsAt, endsAt, context },
) {
  const data = await gql(admin, DISCOUNT_CREATE, {
    discount: {
      title,
      functionId,
      startsAt,
      ...(endsAt ? { endsAt } : {}),
      ...(context ? { context } : {}),
      discountClasses: ["PRODUCT"],
      combinesWith,
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

// Read whether a discount exists and its current customer-eligibility context
// (used to diff eligibility into a declarative add/remove on update).
async function readDiscountState(admin, discountId) {
  if (!discountId) return { exists: false, context: null };
  try {
    const data = await gql(admin, GET_DISCOUNT_STATUS, { id: discountId });
    const node = data?.discountNode;
    if (!node?.id) return { exists: false, context: null };
    return { exists: true, context: normalizeContext(node.discount?.context) };
  } catch {
    return { exists: false, context: null };
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
  const combinesWith = combinesWithFor(config);
  const { startsAt, endsAt } = discountDatesFor(config);
  const isEnabled = config.enabled !== false;
  const isLive = String(config.mode || "live").toLowerCase() !== "test";

  let discountId = row.discountId;
  const { exists, context: currentContext } = await readDiscountState(
    admin,
    discountId,
  );

  if (!exists) {
    // Fresh discount. Active only when the config is enabled AND live.
    const context = await buildContextInput(admin, config, null);
    discountId = await createDiscount(admin, {
      functionId,
      title,
      payload,
      active: isEnabled && isLive,
      combinesWith,
      startsAt,
      endsAt,
      context,
    });
    await prisma.gwpAppV1Config.update({
      where: { id: row.id },
      data: { discountId },
    });
    return discountId;
  }

  // Existing discount: keep title, combinations, active window + payload current.
  // The active state is left to the merchant (manual override) except a disabled
  // config is forced off.
  const context = await buildContextInput(admin, config, currentContext);
  try {
    await gql(admin, DISCOUNT_UPDATE, {
      id: discountId,
      discount: {
        title,
        combinesWith,
        startsAt,
        ...(endsAt ? { endsAt } : {}),
        ...(context ? { context } : {}),
      },
    });
  } catch (err) {
    console.error("Updating GWP discount failed", err);
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
// the saved-config cards. One discountNode lookup per config (handful of rows).
export async function getConfigDiscountMap(admin, shop, rows) {
  const map = {};
  await Promise.all(
    rows.map(async (r) => {
      map[r.id] = { exists: false, discountId: r.discountId || null };
      if (!r.discountId) return;
      let node;
      try {
        const data = await gql(admin, GET_DISCOUNT_STATUS, { id: r.discountId });
        node = data?.discountNode;
      } catch {
        return;
      }
      if (!node?.id) return; // discount was deleted out from under us
      const discount = node.discount ?? {};
      const numericId = String(r.discountId).match(/\/(\d+)$/)?.[1] ?? null;
      const ctx = normalizeContext(discount.context);
      const eligibility =
        ctx.type === "customers"
          ? `${ctx.customerIds.length} customer${ctx.customerIds.length === 1 ? "" : "s"}`
          : ctx.type === "segments"
            ? `${ctx.segmentIds.length} segment${ctx.segmentIds.length === 1 ? "" : "s"}`
            : "All customers";
      map[r.id] = {
        exists: true,
        discountId: r.discountId,
        status: discount.status ?? null, // ACTIVE | EXPIRED | SCHEDULED
        title: discount.title ?? null,
        eligibility,
        adminUrl:
          shop && numericId
            ? `https://${shop}/admin/discounts/${numericId}`
            : null,
      };
    }),
  );
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

// List the shop's customer segments for the eligibility picker in the builder.
export async function listSegments(admin) {
  try {
    const data = await gql(admin, LIST_SEGMENTS);
    return (data?.segments?.nodes || []).map((n) => ({ id: n.id, name: n.name }));
  } catch (err) {
    console.error("Listing customer segments failed", err);
    return [];
  }
}
