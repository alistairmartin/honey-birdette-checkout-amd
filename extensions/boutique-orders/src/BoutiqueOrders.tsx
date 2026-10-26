// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-07 API). No React / @shopify/ui-extensions-react.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// The target is bound in shopify.extension.toml
// (customer-account.page.render -> this module).
export default async () => {
  render(<BoutiqueOrders />, document.body);
};

// The AMD Checkout app backend (Render). Same for every store.
const API_URL = "https://honey-birdette-checkout-amd.onrender.com";

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

function money(amount, currency) {
  return shopify.i18n.formatCurrency(amount, { currency });
}

// "01 Sep 2027", matching the Honey Club cards.
function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return shopify.i18n.formatDate(date, { day: "2-digit", month: "short", year: "numeric" });
}

async function fetchPage(page) {
  const token = await shopify.sessionToken.get();
  const params = new URLSearchParams({ page: String(page), scope: "store" });
  const resp = await fetch(`${API_URL}/api/omneo-transactions?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
  return resp.json();
}

function BoutiqueOrders() {
  // undefined = loading, null = failed, array = loaded.
  const [transactions, setTransactions] = useState(undefined);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPage(1)
      .then((data) => {
        if (cancelled) return;
        setTransactions(data.transactions || []);
        setHasMore(!!data.hasMore);
      })
      .catch((e) => {
        console.error("BoutiqueOrders: failed to load", e);
        if (!cancelled) setTransactions(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore() {
    setLoadingMore(true);
    setMoreError(false);
    try {
      const data = await fetchPage(page + 1);
      setTransactions((prev) => [...prev, ...(data.transactions || [])]);
      setHasMore(!!data.hasMore);
      setPage(page + 1);
    } catch (e) {
      console.error("BoutiqueOrders: failed to load more", e);
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  let body;
  if (transactions === undefined) {
    body = (
      <s-section>
        <s-skeleton-paragraph />
      </s-section>
    );
  } else if (transactions === null) {
    // Unlike the Orders-page block, this is the whole page, so say why it's empty.
    body = (
      <s-section>
        <s-text color="subdued">{t("loadError")}</s-text>
      </s-section>
    );
  } else if (transactions.length === 0 && !hasMore) {
    body = (
      <s-section>
        <s-text color="subdued">{t("empty")}</s-text>
      </s-section>
    );
  } else {
    body = (
      <s-stack gap="base">
        {transactions.map((tx) => (
          <s-section key={tx.id}>
            <Transaction tx={tx} />
          </s-section>
        ))}

        {moreError && <s-text color="subdued">{t("loadMoreError")}</s-text>}

        {hasMore && (
          <s-button variant="secondary" loading={loadingMore} onClick={loadMore}>
            {t("showMore")}
          </s-button>
        )}
      </s-stack>
    );
  }

  return <s-page heading={t("heading")}>{body}</s-page>;
}

// "10 / DD · Qty 2". Returned lines have a negative quantity.
function ItemDetails({ item }) {
  const quantity = Math.abs(item.quantity);
  const parts = [item.size, quantity > 1 && t("quantity", { quantity })].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <s-text type="small" color="subdued">
      {parts.join(" · ")}
    </s-text>
  );
}

// Full page has room, so every item is listed (the block caps at 3).
function Transaction({ tx }) {
  const details = [tx.location, tx.receipt && t("receipt", { ref: tx.receipt })].filter(Boolean);

  return (
    <s-stack gap="base">
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">{formatDate(tx.date)}</s-text>
            {tx.isReturn && <s-badge tone="critical">{t("return")}</s-badge>}
          </s-stack>
          <s-text type="strong">{money(tx.total, tx.currency)}</s-text>
        </s-stack>

        {details.length > 0 && (
          <s-text type="small" color="subdued">
            {details.join(" · ")}
          </s-text>
        )}
      </s-stack>

      <s-divider />

      {tx.items.map((item, i) => (
        <s-stack
          key={`${tx.id}-${i}`}
          direction="inline"
          gap="small-300"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-product-thumbnail src={item.image || undefined} alt={item.name} size="small" />
            <s-stack gap="none">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text>{item.name}</s-text>
                {item.isReturn && <s-badge tone="critical">{t("return")}</s-badge>}
              </s-stack>
              <ItemDetails item={item} />
            </s-stack>
          </s-stack>
          {item.price != null && <s-text>{money(item.price, tx.currency)}</s-text>}
        </s-stack>
      ))}
    </s-stack>
  );
}
