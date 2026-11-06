import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import { getAccountGifts } from "../lib/accountGifts.server";

// Backs the "Exclusive gifts" section on the honey-club-page customer-account
// extension: tier-gated gift offers marked "Show in customer account" that this
// customer is eligible for and hasn't redeemed. Read-only.
//
// Auth: authenticate.public.customerAccount verifies the extension's signed
// session token, so the customer and shop come from the JWT (`sub` / `dest`),
// never from the request. Same pattern as api.honey-club.jsx.

export const loader = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const shop = String(sessionToken?.dest || "").replace(/^https?:\/\//, "");
  const digits = String(sessionToken?.sub || "").replace(/[^0-9]/g, "");
  const customerId = digits ? `gid://shopify/Customer/${digits}` : "";
  if (!shop || !customerId) {
    return cors(json({ error: "Unauthenticated" }, { status: 401 }));
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    return cors(json(await getAccountGifts(admin, shop, customerId)));
  } catch (err) {
    console.error("account-gifts failed", err);
    // No gifts is the safe answer; the rest of the page doesn't depend on it.
    return cors(json({ gifts: [] }, { status: 500 }));
  }
};
