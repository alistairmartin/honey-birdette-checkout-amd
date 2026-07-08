import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import { getConfigUsageState } from "../lib/gwpAppV1.server";

// Backs the gift-with-purchase checkout extension's max-total-uses sold-out gate.
// The extension can't read a discount's usage count from the storefront API, so
// it posts the config's row id here; this endpoint reads the discount's
// `asyncUsageCount` via the Admin API, deactivates the discount once it reaches
// the configured cap (hard stop), and returns whether the offer is sold out.

// Browsers issue a CORS preflight before POSTing. authenticate.public.checkout
// handles the OPTIONS response with the right Access-Control-Allow-* headers.
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

  const configId = typeof body.config_id === "string" ? body.config_id.trim() : "";
  if (!configId) {
    return cors(json({ soldOut: false }));
  }

  // sessionToken.dest is the shop's *.myshopify.com URL, derived from the signed
  // JWT, so a caller can't inspect another shop's discounts via the request body.
  const shop = sessionToken.dest || "";
  if (!shop) {
    return cors(json({ error: "Missing shop in session token" }, { status: 401 }));
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const state = await getConfigUsageState(admin, shop, configId);
    return cors(json(state));
  } catch (err) {
    console.error("gwp-usage-check failed", err);
    // Fail open: a backend error returns not-sold-out so the UI doesn't hide a
    // valid gift. The sync-time cap enforcement is the backstop.
    return cors(json({ soldOut: false }));
  }
};
