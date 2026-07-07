import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";

// Backs the "size-preference" customer-account UI extension. Customer-account
// extensions can't write Admin metafields directly, so the extension reads/writes
// the store-owned `size_preference` customer metafields through here.
//
// Auth: authenticate.public.customerAccount verifies the extension's signed
// session token. `sessionToken.sub` is the authenticated customer's GID and
// `sessionToken.dest` is the shop's *.myshopify.com URL — both come from the
// signed JWT, so a caller can't impersonate another customer or shop via the body.
//
// The metafields (band, cup, thong, brief, suspender, corset, skirt, swimsuit,
// top, bodysuit, hosiery, robe, latex) are documented in
// info/design_handoff_size_preference/METAFIELDS.md. This route trusts that the
// definitions already exist; it only sets/deletes values.

const NAMESPACE = "size_preference";
const TYPE = "single_line_text_field";

// Allowed values per key (AU sizing). Anything not in these lists is ignored.
const ALLOWED = {
  band: ["8", "10", "12", "14", "16"],
  cup: ["A", "B", "C", "D", "DD", "E", "F", "G"],
  thong: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  brief: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  suspender: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  corset: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  skirt: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  swimsuit: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  top: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  bodysuit: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  hosiery: ["S", "M", "L"],
  robe: ["S/M", "M/L"],
  latex: ["S/M", "M/L"],
};
const KEYS = Object.keys(ALLOWED);

const READ_QUERY = `#graphql
  query CustomerSizePreference($ownerId: ID!) {
    customer(id: $ownerId) {
      id
      metafields(first: 50, namespace: "${NAMESPACE}") {
        nodes { key value }
      }
    }
  }
`;

const SET_MUTATION = `#graphql
  mutation SetSizePreference($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key value }
      userErrors { field message code }
    }
  }
`;

const DELETE_MUTATION = `#graphql
  mutation DeleteSizePreference($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

// The customer-account session token `sub` is the authenticated customer GID.
function customerGid(sub) {
  const raw = String(sub || "");
  if (!raw) return "";
  if (raw.startsWith("gid://")) return raw;
  return `gid://shopify/Customer/${raw.replace(/[^0-9]/g, "")}`;
}

function emptySizes() {
  return KEYS.reduce((acc, k) => ({ ...acc, [k]: null }), {});
}

async function readSizes(admin, ownerId) {
  const resp = await admin.graphql(READ_QUERY, { variables: { ownerId } });
  const payload = await resp.json();
  const nodes = payload?.data?.customer?.metafields?.nodes ?? [];
  const sizes = emptySizes();
  for (const node of nodes) {
    if (KEYS.includes(node.key) && node.value) sizes[node.key] = node.value;
  }
  return sizes;
}

// Browsers/extensions issue a CORS preflight before the request.
// authenticate.public.customerAccount handles OPTIONS and sets the CORS headers.
export const loader = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const ownerId = customerGid(sessionToken?.sub);
  const shop = sessionToken?.dest || "";
  if (!ownerId || !shop) {
    return cors(json({ error: "Unauthenticated" }, { status: 401 }));
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const sizes = await readSizes(admin, ownerId);
    return cors(json({ sizes }));
  } catch (err) {
    console.error("size-preference read failed", err);
    return cors(json({ error: "Failed to load size profile" }, { status: 500 }));
  }
};

export const action = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  if (request.method !== "POST") {
    return cors(json({ error: "Method not allowed" }, { status: 405 }));
  }

  const ownerId = customerGid(sessionToken?.sub);
  const shop = sessionToken?.dest || "";
  if (!ownerId || !shop) {
    return cors(json({ error: "Unauthenticated" }, { status: 401 }));
  }

  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return cors(json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  const incoming = body?.sizes && typeof body.sizes === "object" ? body.sizes : {};

  // Split the requested state into values to set (valid, present) and keys to
  // clear (null/empty/invalid). An empty string can't be stored — it fails the
  // `choices` validation — so clears are deletes.
  const toSet = [];
  const toDelete = [];
  for (const key of KEYS) {
    const raw = incoming[key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value && ALLOWED[key].includes(value)) {
      toSet.push({ ownerId, namespace: NAMESPACE, key, type: TYPE, value });
    } else {
      toDelete.push({ ownerId, namespace: NAMESPACE, key });
    }
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const userErrors = [];

    if (toSet.length) {
      const resp = await admin.graphql(SET_MUTATION, { variables: { metafields: toSet } });
      const payload = await resp.json();
      userErrors.push(...(payload?.data?.metafieldsSet?.userErrors ?? []));
    }

    if (toDelete.length) {
      const resp = await admin.graphql(DELETE_MUTATION, {
        variables: { metafields: toDelete },
      });
      const payload = await resp.json();
      // Deleting a metafield that doesn't exist is a no-op, not an error.
      userErrors.push(...(payload?.data?.metafieldsDelete?.userErrors ?? []));
    }

    // Re-read so the client gets the authoritative persisted state.
    const sizes = await readSizes(admin, ownerId);
    return cors(json({ sizes, userErrors }));
  } catch (err) {
    console.error("size-preference save failed", err);
    return cors(json({ error: "Failed to save size profile" }, { status: 500 }));
  }
};
