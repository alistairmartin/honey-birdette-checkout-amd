// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-07 API). No React / @shopify/ui-extensions-react.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// The target is bound in shopify.extension.toml
// (customer-account.order-index.block.render -> this module).
export default async () => {
  render(<OmneoTransactions />, document.body);
};

const DEFAULT_API_URL = "https://honey-birdette-checkout-amd.onrender.com";
const ITEMS_SHOWN = 3;

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

function setting(key) {
  const value = shopify.settings?.value?.[key];
  return typeof value === "string" ? value.trim() : value;
}

function apiBase() {
  return (setting("api_url") || DEFAULT_API_URL).replace(/\/+$/, "");
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

async function fetchPage(page, includeOnline) {
  const token = await shopify.sessionToken.get();
  const params = new URLSearchParams({ page: String(page), scope: includeOnline ? "all" : "store" });
  const resp = await fetch(`${apiBase()}/api/omneo-transactions?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
  return resp.json();
}

function OmneoTransactions() {
  const includeOnline = setting("include_online") === true;
  // undefined = loading, null = failed (render nothing), array = loaded.
  const [transactions, setTransactions] = useState(undefined);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPage(1, includeOnline)
      .then((data) => {
        if (cancelled) return;
        setTransactions(data.transactions || []);
        setHasMore(!!data.hasMore);
      })
      .catch((e) => {
        console.error("OmneoTransactions: failed to load", e);
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
      const data = await fetchPage(page + 1, includeOnline);
      setTransactions((prev) => [...prev, ...(data.transactions || [])]);
      setHasMore(!!data.hasMore);
      setPage(page + 1);
    } catch (e) {
      console.error("OmneoTransactions: failed to load more", e);
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const heading = setting("heading") || t(includeOnline ? "headingAll" : "heading");

  if (transactions === undefined) {
    return (
      <s-section heading={heading}>
        <s-skeleton-paragraph />
      </s-section>
    );
  }

  // On a backend/Omneo failure, show nothing rather than a misleading empty list.
  if (transactions === null) return null;

  return (
    <s-section heading={heading}>
      <s-stack gap="base">
        {transactions.length === 0 && !hasMore ? (
          <s-text color="subdued">{t(includeOnline ? "emptyAll" : "empty")}</s-text>
        ) : (
          transactions.map((tx, i) => (
            <s-stack key={tx.id} gap="base">
              {i > 0 && <s-divider />}
              <Transaction tx={tx} showChannel={includeOnline} />
            </s-stack>
          ))
        )}

        {moreError && <s-text color="subdued">{t("loadError")}</s-text>}

        {hasMore && (
          <s-button variant="secondary" loading={loadingMore} onClick={loadMore}>
            {t("showMore")}
          </s-button>
        )}
      </s-stack>
    </s-section>
  );
}

function Transaction({ tx, showChannel }) {
  const shown = tx.items.slice(0, ITEMS_SHOWN);
  const hidden = tx.items.length - shown.length;
  const details = [tx.location, tx.receipt && t("receipt", { ref: tx.receipt })].filter(Boolean);

  return (
    <s-stack gap="small-200">
      <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text type="strong">{formatDate(tx.date)}</s-text>
          {showChannel && <s-badge>{t(tx.channel === "online" ? "online" : "inStore")}</s-badge>}
          {tx.isReturn && <s-badge tone="critical">{t("return")}</s-badge>}
        </s-stack>
        <s-text type="strong">{money(tx.total, tx.currency)}</s-text>
      </s-stack>

      {details.length > 0 && (
        <s-text type="small" color="subdued">
          {details.join(" · ")}
        </s-text>
      )}

      {shown.map((item, i) => (
        <s-stack key={`${tx.id}-${i}`} direction="inline" gap="small-300" alignItems="center">
          {item.image && <s-product-thumbnail src={item.image} alt={item.name} size="small" />}
          <s-stack gap="none">
            <s-text>{item.name}</s-text>
            {item.quantity > 1 && (
              <s-text type="small" color="subdued">
                {t("quantity", { quantity: item.quantity })}
              </s-text>
            )}
          </s-stack>
        </s-stack>
      ))}

      {hidden > 0 && (
        <s-text type="small" color="subdued">
          {t("moreItems", { count: hidden })}
        </s-text>
      )}
    </s-stack>
  );
}
