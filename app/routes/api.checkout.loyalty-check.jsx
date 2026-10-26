import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import { regionForShop } from "../lib/loyaltyTierSync.server";
import { tierForCustomerTags } from "../lib/loyaltyOrderTags.server";

// Backs loyalty exclusives in the gift-with-purchase checkout extension:
// returns the buyer's Honey Club tier so the extension only offers a
// tier-limited gift to eligible customers. Checkout extensions can't read
// customer tags, which is where the tier lives (cx-tier-<tier>-<region>).
//
// The buyer is the logged-in customer from the signed session token (`sub`)
// when there is one, else the email typed at checkout. Same auth pattern as
// api.checkout.redemption-check.jsx. The discount itself is also restricted to
// the tier segments, so a wrong answer here can't give the gift away.

const BY_ID = `#graphql
  query LoyaltyCheckById($id: ID!) {
    customer(id: $id) { tags }
  }`;

const BY_EMAIL = `#graphql
  query LoyaltyCheckByEmail($q: String!) {
    customers(query: $q, first: 1) { nodes { tags } }
  }`;

export const loader = async ({ request }) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(json({ ok: true }));
};

export const action = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.checkout(request);

  if (request.method !== "POST") {
    return cors(json({ error: "Method not allowed" }, { status: 405 }));
  }

  let body = {};
  try {
    body = await request.json();
  } catch (_e) {
    // An empty body is fine for a logged-in buyer.
  }

  const shop = String(sessionToken?.dest || "").replace(/^https?:\/\//, "");
  if (!shop) {
    return cors(json({ error: "Missing shop in session token" }, { status: 401 }));
  }
  const region = regionForShop(shop);
  const customerId = String(sessionToken?.sub || "").startsWith("gid://shopify/Customer/")
    ? sessionToken.sub
    : null;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!region || (!customerId && !email.includes("@"))) {
    return cors(json({ tier: null }));
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const resp = customerId
      ? await admin.graphql(BY_ID, { variables: { id: customerId } })
      : await admin.graphql(BY_EMAIL, { variables: { q: `email:"${email.replace(/"/g, '\\"')}"` } });
    const { data } = await resp.json();
    const tags = customerId ? data?.customer?.tags : data?.customers?.nodes?.[0]?.tags;
    return cors(json({ tier: tierForCustomerTags(tags || [], region) }));
  } catch (err) {
    console.error("loyalty-check failed", err);
    // Fail closed: no tier means no exclusive gift offered.
    return cors(json({ tier: null }, { status: 502 }));
  }
};
