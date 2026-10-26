// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object. No React / @shopify/ui-extensions-react.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// The target is bound in shopify.extension.toml
// (customer-account.page.render -> this module).
export default async () => {
  render(<VipPresalePage />, document.body);
};

const PAGE_SIZE = 48;

// Settings from the app admin (/app/vip-presale): { collectionHandle, percentOff }.
const SETTINGS_QUERY = `#graphql
  query VipPresaleSettings {
    shop {
      metafield(namespace: "$app", key: "vip_presale") {
        value
      }
    }
  }
`;

// @inContext prices the products in the customer's country (EU stores sell in
// several currencies).
const PRODUCTS_QUERY = `#graphql
  query VipPresaleProducts($handle: String!, $first: Int!, $after: String, $country: CountryCode)
  @inContext(country: $country) {
    collection(handle: $handle) {
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          onlineStoreUrl
          featuredImage {
            url(transform: { maxWidth: 600 })
            altText
          }
          variants(first: 100) {
            nodes {
              id
              title
              availableForSale
              price {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;

function t(key, replacements) {
  return shopify.i18n.translate(key, replacements);
}

function money(amount, currencyCode) {
  return shopify.i18n.formatCurrency(amount, { currency: currencyCode });
}

// Rounded to the cent, as the automatic discount rounds each line.
function discounted(amount, percentOff) {
  return Math.round(Number(amount) * (100 - percentOff)) / 100;
}

async function query(text, variables) {
  const result = await shopify.query(text, { variables });
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result.data;
}

async function loadSettings() {
  const data = await query(SETTINGS_QUERY);
  const parsed = JSON.parse(data?.shop?.metafield?.value || "{}");
  return {
    collectionHandle: parsed.collectionHandle || "",
    percentOff: Number(parsed.percentOff) || 0,
  };
}

async function loadProducts(handle, after) {
  const data = await query(PRODUCTS_QUERY, {
    handle,
    first: PAGE_SIZE,
    after,
    country: shopify.localization?.country?.value?.isoCode,
  });
  const page = data?.collection?.products;
  if (!page) return { products: [], next: null };
  return {
    // No storefront URL means the product isn't on the Online Store, so it can't be bought there.
    products: page.nodes.filter((p) => p.onlineStoreUrl),
    next: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
  };
}

function VipPresalePage() {
  const [settings, setSettings] = useState(null);
  // undefined = loading, null = failed, array = loaded.
  const [products, setProducts] = useState(undefined);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const loaded = await loadSettings();
        if (cancelled) return;
        setSettings(loaded);
        if (!loaded.collectionHandle) {
          setProducts([]);
          return;
        }
        const page = await loadProducts(loaded.collectionHandle, null);
        if (cancelled) return;
        setProducts(page.products);
        setCursor(page.next);
      } catch (e) {
        console.error("VipPresalePage: failed to load", e);
        if (!cancelled) setProducts(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await loadProducts(settings.collectionHandle, cursor);
      setProducts((current) => [...current, ...page.products]);
      setCursor(page.next);
    } catch (e) {
      console.error("VipPresalePage: failed to load more", e);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <s-page heading={t("pageHeading")}>
      <s-stack gap="base">
        <s-text color="subdued">
          {settings?.percentOff ? t("introPercent", { percent: settings.percentOff }) : t("intro")}
        </s-text>
        <ProductGrid products={products} percentOff={settings?.percentOff ?? 0} />
        {products?.length > 0 && cursor && (
          <s-button variant="secondary" loading={loadingMore} onClick={loadMore}>
            {t("loadMore")}
          </s-button>
        )}
      </s-stack>
    </s-page>
  );
}

function ProductGrid({ products, percentOff }) {
  if (products === undefined) {
    return (
      <s-section>
        <s-skeleton-paragraph />
      </s-section>
    );
  }
  if (products === null) {
    return (
      <s-section>
        <s-text color="subdued">{t("loadError")}</s-text>
      </s-section>
    );
  }
  if (!products.length) {
    return (
      <s-section>
        <s-text color="subdued">{t("empty")}</s-text>
      </s-section>
    );
  }

  return (
    <s-query-container>
      <s-grid
        gridTemplateColumns="@container (inline-size > 900px) 1fr 1fr 1fr 1fr, @container (inline-size > 500px) 1fr 1fr 1fr, 1fr 1fr"
        gap="base"
      >
        {products.map((product) => (
          <ProductCard key={product.id} product={product} percentOff={percentOff} />
        ))}
      </s-grid>
    </s-query-container>
  );
}

function ProductCard({ product, percentOff }) {
  const available = product.variants.nodes.filter((v) => v.availableForSale);
  // Cheapest variant, so the card shows a "from" price like a collection page.
  const cheapest = product.variants.nodes.reduce((min, v) =>
    Number(v.price.amount) < Number(min.price.amount) ? v : min,
  );
  const { amount, currencyCode } = cheapest.price;

  return (
    <s-stack gap="small-300">
      <s-clickable href={product.onlineStoreUrl} accessibilityLabel={product.title}>
        <s-stack gap="small-300">
          <s-image
            src={product.featuredImage?.url}
            alt={product.featuredImage?.altText || product.title}
            inlineSize="fill"
            aspectRatio="0.75"
            objectFit="cover"
            borderRadius="base"
          />
          <s-text>{product.title}</s-text>
          {percentOff ? (
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text type="strong">{money(discounted(amount, percentOff), currencyCode)}</s-text>
              <s-text type="redundant" color="subdued">
                {money(Number(amount), currencyCode)}
              </s-text>
              <s-badge>{t("percentOff", { percent: percentOff })}</s-badge>
            </s-stack>
          ) : (
            <s-text type="strong">{money(Number(amount), currencyCode)}</s-text>
          )}
        </s-stack>
      </s-clickable>
      <QuickAdd product={product} available={available} />
    </s-stack>
  );
}

// Customer account pages have no cart API, so quick add sends the customer to
// the storefront's /cart/add, which adds the variant and opens the cart.
function QuickAdd({ product, available }) {
  const [variantId, setVariantId] = useState(available.length === 1 ? available[0].id : "");

  if (!available.length) {
    return (
      <s-button variant="secondary" disabled>
        {t("soldOut")}
      </s-button>
    );
  }

  const storefront = new URL(product.onlineStoreUrl).origin;
  const numericId = variantId.split("/").pop();
  // A single "Default Title" variant needs no picker.
  const showPicker = product.variants.nodes.length > 1;

  return (
    <s-stack gap="small-300">
      {showPicker && (
        <s-select
          label={t("size")}
          value={variantId}
          onChange={(event) => setVariantId(event.currentTarget.value)}
        >
          <s-option value="">{t("selectSize")}</s-option>
          {available.map((v) => (
            <s-option key={v.id} value={v.id}>
              {v.title}
            </s-option>
          ))}
        </s-select>
      )}
      <s-button
        variant="primary"
        disabled={!variantId}
        href={variantId ? `${storefront}/cart/add?id=${numericId}&quantity=1` : undefined}
      >
        {t("addToBag")}
      </s-button>
    </s-stack>
  );
}
