import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import { readLoyaltyMessages } from "../lib/loyaltyMessages.server";

// Backs the loyalty messaging banners on the "honey-club-page" customer-account
// extension. Read-only; messages are edited at /app/loyalty/messaging.
//
// Auth: authenticate.public.customerAccount verifies the extension's signed
// session token, so the shop comes from the JWT (`dest`), never the request.
// Date and audience filtering happen in the extension (customer's local time,
// and it already knows whether they're a member).

export const loader = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const shop = String(sessionToken?.dest || "").replace(/^https?:\/\//, "");
  if (!shop) {
    return cors(json({ error: "Unauthenticated" }, { status: 401 }));
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const { messages } = await readLoyaltyMessages(admin);
    return cors(json({ messages }));
  } catch (err) {
    console.error("loyalty-messages read failed", err);
    return cors(json({ error: "Failed to load loyalty messages" }, { status: 500 }));
  }
};
