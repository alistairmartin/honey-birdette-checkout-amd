import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  findOmneoProfile,
  getOmneoTransactions,
  omneoShopConfig,
  omneoConfigured,
} from "../lib/omneo.server";

// Backs the "omneo-transactions" customer-account UI extension on the Orders
// page. Shopify's native order list only shows Shopify orders; in-store (POS)
// purchases live in Omneo, so this lists the customer's Omneo transactions.
// Read-only.
//
// Auth: authenticate.public.customerAccount verifies the extension's signed
// session token, so the customer and shop come from the JWT (`sub` / `dest`),
// never from the request. Same pattern as api.honey-club.jsx.
//
// Query: ?page=N (1-based), ?scope=store|all (default store = in-store only,
// since online orders already show in the native list).

const PAGE_SIZE = 10;
// Omneo may return fewer store transactions per page than requested once
// online ones are filtered out, so fetch wider pages when scope=store.
const STORE_SCOPE_PAGE_SIZE = 25;

function numericCustomerId(sub) {
  return String(sub || "").replace(/[^0-9]/g, "");
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function systemHandles(transaction) {
  return (transaction.systems || [])
    .map((s) => (typeof s === "string" ? s : s?.handle))
    .filter(Boolean)
    .map((h) => String(h).toLowerCase());
}

// Online = came from a Shopify store (system handle shopify-au etc.) or an
// online location. Everything else is treated as an in-store purchase.
function channelOf(transaction) {
  if (systemHandles(transaction).some((h) => h.startsWith("shopify"))) return "online";
  const locationType = String(transaction.location?.type || "").toLowerCase();
  if (locationType === "online" || locationType === "web" || locationType === "ecommerce") {
    return "online";
  }
  return "store";
}

// product_images is typed as an array in the SDK but an object in the API docs.
function itemImage(item) {
  const images = item.product_images;
  const first = Array.isArray(images) ? images[0] : images && (images.url ? images : Object.values(images)[0]);
  const url = typeof first === "string" ? first : first?.url;
  return url || item.product_variant?.images?.[0]?.url || null;
}

function toTransaction(t, fallbackCurrency) {
  const total = toNumber(t.total) ?? 0;
  const type = String(t.type || "").toLowerCase();
  return {
    id: String(t.id),
    date: t.transacted_at || t.created_at || null,
    total,
    currency: typeof t.currency === "string" && t.currency.length === 3 ? t.currency : fallbackCurrency,
    channel: channelOf(t),
    location: t.location?.name || null,
    receipt: t.receipt_ref || t.order_number || null,
    isReturn: total < 0 || type.includes("return") || type.includes("refund"),
    items: (t.items || [])
      .filter((item) => !item.is_void)
      .map((item) => ({
        name: item.name || item.product?.title || "",
        quantity: toNumber(item.quantity) ?? 1,
        price: toNumber(item.price_sell) ?? toNumber(item.price_current),
        image: itemImage(item),
      })),
  };
}

// authenticate.public.customerAccount handles the CORS preflight and headers.
export const loader = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const customerId = numericCustomerId(sessionToken?.sub);
  const shop = String(sessionToken?.dest || "").replace(/^https?:\/\//, "");
  if (!customerId || !shop) {
    return cors(json({ error: "Unauthenticated" }, { status: 401 }));
  }
  if (!omneoConfigured()) {
    return cors(json({ error: "Omneo not configured" }, { status: 503 }));
  }

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const storeOnly = url.searchParams.get("scope") !== "all";
  const currency = omneoShopConfig(shop)?.currency ?? "AUD";

  try {
    const profile = await findOmneoProfile(shop, customerId);
    if (!profile) return cors(json({ transactions: [], hasMore: false, currency }));

    const pageSize = storeOnly ? STORE_SCOPE_PAGE_SIZE : PAGE_SIZE;
    const result = await getOmneoTransactions(profile.id, { page, pageSize });
    const raw = Array.isArray(result?.data) ? result.data : [];
    // Pagination meta isn't documented; use it if present, else a full page
    // means there may be more.
    const lastPage = toNumber(result?.meta?.last_page);
    const hasMore = lastPage !== null ? page < lastPage : raw.length >= pageSize;

    const transactions = raw
      .filter((t) => !t.is_void)
      .map((t) => toTransaction(t, currency))
      .filter((t) => !storeOnly || t.channel === "store");

    return cors(json({ transactions, hasMore, page, currency }));
  } catch (err) {
    console.error("omneo-transactions read failed", err);
    return cors(json({ error: "Failed to load transactions" }, { status: 502 }));
  }
};
