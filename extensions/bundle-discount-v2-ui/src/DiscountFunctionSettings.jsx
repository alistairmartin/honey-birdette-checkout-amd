import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useMemo, useState} from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

const METAOBJECT_TYPE = "lubricant_bundle";
const SUPPORTED_CURRENCIES = ["AUD", "NZD", "USD", "CAD", "EUR", "GBP", "AED"];
const MONEY_FIELD_KEY = (code) => `discount_${code.toLowerCase()}`;

const LIST_BUNDLES_QUERY = `#graphql
  query ListBundles($type: String!) {
    metaobjects(type: $type, first: 100) {
      nodes {
        id
        displayName
      }
    }
  }
`;

const GET_BUNDLE_QUERY = `#graphql
  query GetBundle($id: ID!) {
    metaobject(id: $id) {
      id
      displayName
      fields {
        key
        value
        references(first: 100) {
          nodes {
            ... on Product {
              id
              title
              featuredMedia { preview { image { url } } }
              variants(first: 10) {
                nodes {
                  sku
                  price
                  image { url }
                }
              }
              priceRangeV2 { minVariantPrice { amount currencyCode } }
            }
          }
        }
      }
    }
  }
`;

function emptyDiscountAmounts() {
  return SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = 0;
    return acc;
  }, {});
}

function flattenMetaobject(metaobject) {
  const fieldByKey = new Map();
  for (const f of metaobject.fields ?? []) {
    fieldByKey.set(f.key, f);
  }

  const refProducts = (key) =>
    (fieldByKey.get(key)?.references?.nodes ?? [])
      .filter((n) => n?.id)
      .map((n) => {
        const variants = n.variants?.nodes ?? [];
        // Prefer a variant value, fall back to the product-level value.
        const variantSku = variants.find((v) => v?.sku)?.sku ?? "";
        const variantImage = variants.find((v) => v?.image?.url)?.image?.url ?? "";
        const variantPrice = variants.find((v) => v?.price)?.price ?? "";
        const productImage = n.featuredMedia?.preview?.image?.url ?? "";
        return {
          id: n.id,
          title: n.title ?? "",
          sku: variantSku,
          imageUrl: variantImage || productImage,
          price: variantPrice || (n.priceRangeV2?.minVariantPrice?.amount ?? ""),
          currency: n.priceRangeV2?.minVariantPrice?.currencyCode ?? "",
        };
      });

  const discountAmounts = emptyDiscountAmounts();
  for (const code of SUPPORTED_CURRENCIES) {
    const f = fieldByKey.get(MONEY_FIELD_KEY(code));
    if (!f?.value) continue;
    try {
      const parsed = JSON.parse(f.value);
      discountAmounts[code] = Number(parsed.amount ?? 0);
    } catch {
      // ignore malformed money values
    }
  }

  const products = refProducts("products");
  const option1 = refProducts("option_1");
  const option2 = refProducts("option_2");

  return {
    id: metaobject.id,
    name: metaobject.displayName ?? "",
    products,
    option1,
    option2,
    productIds: products.map((p) => p.id),
    option1Ids: option1.map((p) => p.id),
    option2Ids: option2.map((p) => p.id),
    discountAmounts,
  };
}

function normalizeItems(list, idsFallback, titlesFallback) {
  if (Array.isArray(list)) {
    return list
      .filter((p) => p?.id)
      .map((p) => ({
        id: p.id,
        title: p.title ?? "",
        sku: p.sku ?? "",
        imageUrl: p.imageUrl ?? "",
        price: p.price ?? "",
        currency: p.currency ?? "",
      }));
  }
  // Fall back to older payloads that stored ids/titles in parallel arrays.
  const ids = Array.isArray(idsFallback) ? idsFallback : [];
  const titles = Array.isArray(titlesFallback) ? titlesFallback : [];
  return ids.map((id, i) => ({
    id,
    title: titles[i] ?? "",
    sku: "",
    imageUrl: "",
    price: "",
    currency: "",
  }));
}

function parseMetafield(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (Array.isArray(parsed.bundles)) {
      return parsed.bundles.map((b) => {
        const products = normalizeItems(b.products, b.productIds, b.productTitles);
        const option1 = normalizeItems(b.option1, b.option1Ids, b.option1Titles);
        const option2 = normalizeItems(b.option2, b.option2Ids, b.option2Titles);
        return {
          id: b.id,
          name: b.name ?? "",
          products,
          option1,
          option2,
          productIds: products.map((p) => p.id),
          option1Ids: option1.map((p) => p.id),
          option2Ids: option2.map((p) => p.id),
          discountAmounts: {
            ...emptyDiscountAmounts(),
            ...(b.discountAmounts ?? {}),
          },
        };
      });
    }
  } catch {}
  return [];
}

function ProductRow({product}) {
  const legacyId = product.id.split("/").pop();
  const priceLabel = product.price
    ? `${product.currency ? `${product.currency} ` : ""}${product.price}`
    : "";
  const meta = [
    `SKU: ${product.sku || "n/a"}`,
    priceLabel,
  ]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {product.imageUrl ? (
        <s-thumbnail src={product.imageUrl} alt={product.title} size="small" />
      ) : (
        <s-thumbnail alt={product.title} size="small" />
      )}
      <s-stack gap="none">
        <s-link
          href={`shopify://admin/products/${legacyId}`}
          target="_blank"
        >
          {product.title || "Untitled product"}
        </s-link>
        <s-text tone="subdued">{meta}</s-text>
      </s-stack>
    </s-stack>
  );
}

function App() {
  const {applyMetafieldChange, data, discounts, query} = shopify;

  const initialBundles = useMemo(
    () =>
      parseMetafield(
        data?.metafields?.find((m) => m.key === "function-configuration")
          ?.value,
      ),
    [data?.metafields],
  );

  const [bundles, setBundles] = useState(initialBundles);
  const [availableBundles, setAvailableBundles] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState();

  useEffect(() => {
    // This function only emits order discounts, so force the discount to be
    // order-only. Appending "order" to existing classes left a stray "product"
    // class behind, which surfaced as "Product and order discount".
    const classes = discounts?.discountClasses?.value ?? [];
    const isOrderOnly = classes.length === 1 && classes[0] === "order";
    if (!isOrderOnly) {
      discounts?.updateDiscountClasses?.(["order"]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await query(LIST_BUNDLES_QUERY, {
          variables: {type: METAOBJECT_TYPE},
        });
        if (cancelled) return;
        setAvailableBundles(result?.data?.metaobjects?.nodes ?? []);
      } catch (e) {
        if (!cancelled) setError(`Failed to load bundles: ${e?.message ?? e}`);
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function fetchAndFlatten(id) {
    const result = await query(GET_BUNDLE_QUERY, {variables: {id}});
    const mo = result?.data?.metaobject;
    if (!mo) throw new Error("Metaobject not found");
    return flattenMetaobject(mo);
  }

  async function addBundle(id) {
    if (!id) return;
    if (bundles.some((b) => b.id === id)) return;
    setBusyId(id);
    setError(undefined);
    try {
      const flat = await fetchAndFlatten(id);
      setBundles((prev) => [...prev, flat]);
    } catch (e) {
      setError(`Failed to load bundle: ${e?.message ?? e}`);
    } finally {
      setBusyId(null);
    }
  }

  async function refreshBundle(id) {
    setBusyId(id);
    setError(undefined);
    try {
      const flat = await fetchAndFlatten(id);
      setBundles((prev) => prev.map((b) => (b.id === id ? flat : b)));
    } catch (e) {
      setError(`Failed to refresh: ${e?.message ?? e}`);
    } finally {
      setBusyId(null);
    }
  }

  function removeBundle(id) {
    setBundles((prev) => prev.filter((b) => b.id !== id));
  }

  function handleSubmit(event) {
    const payload = {
      bundleIds: bundles.map((b) => b.id),
      bundles,
    };
    event.waitUntil?.(
      applyMetafieldChange({
        type: "updateMetafield",
        namespace: "$app",
        key: "function-configuration",
        value: JSON.stringify(payload),
        valueType: "json",
      }),
    );
  }

  function handleReset() {
    setBundles(initialBundles);
    setError(undefined);
  }

  const selectableBundles = availableBundles.filter(
    (b) => !bundles.some((sel) => sel.id === b.id),
  );

  return (
    <s-function-settings onSubmit={handleSubmit} onReset={handleReset}>
      <s-box display="none">
        <s-text-field
          label=""
          name="bundles"
          value={JSON.stringify(bundles)}
          defaultValue={JSON.stringify(initialBundles)}
        />
      </s-box>
      <s-section heading="Bundle discounts">
        <s-stack gap="base">
          {error ? <s-banner tone="critical">{error}</s-banner> : null}

          <s-text>
            Each bundle is defined as a <s-text emphasis="bold">Lubricant Bundle</s-text> metaobject
            (Content → Metaobjects). Cart must contain every product in the bundle's
            "Products" list. If Option 1 or Option 2 is set on the bundle, the cart must
            also contain one product from that list. Discounts are charged in the cart's
            checkout currency; bundles with $0 in that currency are skipped. When a cart
            qualifies for multiple bundles, the highest-discount bundle is applied first.
          </s-text>

          {loadingList ? (
            <s-text tone="subdued">Loading bundles…</s-text>
          ) : null}

          {bundles.length === 0 && !loadingList ? (
            <s-text tone="subdued">No bundles selected yet.</s-text>
          ) : null}

          {bundles.map((bundle) => (
            <s-section
              key={bundle.id}
              heading={bundle.name || "Untitled bundle"}
            >
              <s-stack gap="base">
                <s-link
                  href={`shopify://admin/content/entries/${METAOBJECT_TYPE}/${bundle.id.split("/").pop()}`}
                  target="_blank"
                >
                  Edit bundle in Shopify admin
                </s-link>

                <s-stack gap="small">
                  <s-heading>Products (all required)</s-heading>
                  {bundle.products.length ? (
                    bundle.products.map((p) => (
                      <ProductRow key={p.id} product={p} />
                    ))
                  ) : (
                    <s-text tone="critical">No products set on this bundle.</s-text>
                  )}
                </s-stack>

                {bundle.option1.length ? (
                  <s-stack gap="small">
                    <s-heading>Option 1 (customer picks one)</s-heading>
                    {bundle.option1.map((p) => (
                      <ProductRow key={p.id} product={p} />
                    ))}
                  </s-stack>
                ) : null}

                {bundle.option2.length ? (
                  <s-stack gap="small">
                    <s-heading>Option 2 (customer picks one)</s-heading>
                    {bundle.option2.map((p) => (
                      <ProductRow key={p.id} product={p} />
                    ))}
                  </s-stack>
                ) : null}

                <s-stack gap="extraSmall">
                  <s-text emphasis="bold">Discount per currency</s-text>
                  {SUPPORTED_CURRENCIES.map((code) => (
                    <s-text key={code}>
                      {code}: {bundle.discountAmounts?.[code] ?? 0}
                    </s-text>
                  ))}
                </s-stack>

                <s-divider />

                <s-stack direction="inline" gap="base">
                  <s-button
                    onClick={() => refreshBundle(bundle.id)}
                    disabled={busyId === bundle.id}
                  >
                    {busyId === bundle.id ? "Refreshing…" : "Refresh from metaobject"}
                  </s-button>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    onClick={() => removeBundle(bundle.id)}
                  >
                    Remove bundle
                  </s-button>
                </s-stack>
              </s-stack>
            </s-section>
          ))}

          {!loadingList && selectableBundles.length > 0 ? (
            <s-stack gap="extraSmall">
              <s-select
                label="Add a bundle"
                value=""
                onChange={(e) => addBundle(e.currentTarget.value)}
                disabled={busyId !== null}
              >
                <s-option value="">Select a bundle…</s-option>
                {selectableBundles.map((b) => (
                  <s-option key={b.id} value={b.id}>
                    {b.displayName}
                  </s-option>
                ))}
              </s-select>
            </s-stack>
          ) : null}

          {!loadingList && availableBundles.length === 0 ? (
            <s-text tone="subdued">
              No "{METAOBJECT_TYPE}" metaobjects exist yet. Create one in
              Content → Metaobjects first.
            </s-text>
          ) : null}
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}
