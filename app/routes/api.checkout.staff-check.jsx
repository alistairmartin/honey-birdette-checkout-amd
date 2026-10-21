import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";

// Backs the "reject-discount-codes-for-staff" checkout extension. Checkout UI
// extensions can't read customer or product tags, and useCustomer() only resolves
// for logged-in buyers, so the extension posts the typed email + cart product IDs
// here. Returns whether the buyer is a "Honey Birdette Staff" customer AND the cart
// has products tagged "stop-staff-discount-code", plus those product titles.
// Same auth pattern as api.checkout.redemption-check.jsx.

const STAFF_TAG = "honey birdette staff";
const STOP_TAG = "stop-staff-discount-code";

const STAFF_CHECK_QUERY = `#graphql
  query StaffCheck($q: String!, $ids: [ID!]!) {
    customers(query: $q, first: 1) {
      nodes {
        tags
      }
    }
    nodes(ids: $ids) {
      ... on Product {
        title
        tags
      }
    }
  }
`;

const lower = (tags) => (tags || []).map((t) => String(t).trim().toLowerCase());

// Browsers issue a CORS preflight before POSTing. authenticate.public.checkout
// handles the OPTIONS response, returning the right Access-Control-Allow-* headers.
export const loader = async ({ request }) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(json({ ok: true }));
};

export const action = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.checkout(request);

  if (request.method !== "POST") {
    return cors(json({ error: "Method not allowed" }, { status: 405 }));
  }

  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return cors(json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const productIds = Array.isArray(body.product_ids)
    ? [...new Set(body.product_ids.filter((id) => typeof id === "string" && id.startsWith("gid://shopify/Product/")))].slice(0, 100)
    : [];

  if (!email || !email.includes("@") || !productIds.length) {
    return cors(json({ block: false, titles: [] }));
  }

  // sessionToken.dest is the shop's *.myshopify.com URL, derived from the signed
  // JWT, so a caller can't impersonate a different shop via the request body.
  const shop = sessionToken.dest || "";
  if (!shop) {
    return cors(json({ error: "Missing shop in session token" }, { status: 401 }));
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(STAFF_CHECK_QUERY, {
      variables: { q: `email:"${email.replace(/"/g, '\\"')}"`, ids: productIds },
    });
    const payload = await response.json();

    const customerTags = lower(payload?.data?.customers?.nodes?.[0]?.tags);
    if (!customerTags.includes(STAFF_TAG)) {
      return cors(json({ block: false, titles: [] }));
    }

    const titles = (payload?.data?.nodes || [])
      .filter((p) => p && lower(p.tags).includes(STOP_TAG))
      .map((p) => p.title);

    return cors(json({ block: titles.length > 0, titles }));
  } catch (err) {
    console.error("staff-check failed", err);
    // Fail permissive: a backend error doesn't block checkout. The
    // reject-discount-codes-for-staff-function still covers logged-in staff.
    return cors(json({ block: false, titles: [] }));
  }
};
