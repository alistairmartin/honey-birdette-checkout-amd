import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";

// Backs the gift-with-purchase checkout extension's guest-by-email redemption
// check. The extension can only call useCustomer() for authenticated buyers; this
// endpoint looks up a typed email against the `custom.tags` customer metafield via
// the Admin API and returns whether the redeemed tag is present.

const CUSTOMER_BY_EMAIL_QUERY = `#graphql
  query CustomerByEmail($q: String!) {
    customers(query: $q, first: 1) {
      nodes {
        id
        metafield(namespace: "custom", key: "tags") { value }
      }
    }
  }
`;

function normalizeTagList(raw) {
  const value = (raw ?? "").toString().trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v).trim()).filter(Boolean);
    }
  } catch (_e) {
    // fall through to delimited parsing
  }
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

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
  const redeemedTag =
    typeof body.redeemed_tag === "string" ? body.redeemed_tag.trim().toLowerCase() : "";

  if (!email || !email.includes("@")) {
    return cors(json({ redeemed: false }));
  }
  if (!redeemedTag) {
    return cors(json({ redeemed: false }));
  }

  // sessionToken.dest is the shop's *.myshopify.com URL, derived from the signed
  // JWT, so a caller can't impersonate a different shop via the request body.
  const shop = sessionToken.dest || "";
  if (!shop) {
    return cors(json({ error: "Missing shop in session token" }, { status: 401 }));
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(CUSTOMER_BY_EMAIL_QUERY, {
      variables: { q: `email:"${email.replace(/"/g, '\\"')}"` },
    });
    const payload = await response.json();
    const node = payload?.data?.customers?.nodes?.[0];
    const metafieldValue = node?.metafield?.value;

    if (!metafieldValue) {
      return cors(json({ redeemed: false }));
    }

    const tags = normalizeTagList(metafieldValue).map((t) => t.toLowerCase());
    return cors(json({ redeemed: tags.includes(redeemedTag) }));
  } catch (err) {
    console.error("redemption-check failed", err);
    // Fail permissive: a backend error returns false so the UI doesn't block a
    // customer. The merchant's post-order flow is the safety net.
    return cors(json({ redeemed: false }));
  }
};
