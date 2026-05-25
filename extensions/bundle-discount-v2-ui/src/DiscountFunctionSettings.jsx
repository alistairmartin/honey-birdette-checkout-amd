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
            ... on Product { id title }
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

  const refIds = (key) =>
    (fieldByKey.get(key)?.references?.nodes ?? [])
      .map((n) => n?.id)
      .filter(Boolean);

  const refTitles = (key) =>
    (fieldByKey.get(key)?.references?.nodes ?? [])
      .map((n) => n?.title)
      .filter(Boolean);

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

  return {
    id: metaobject.id,
    name: metaobject.displayName ?? "",
    productIds: refIds("products"),
    productTitles: refTitles("products"),
    option1Ids: refIds("option_1"),
    option1Titles: refTitles("option_1"),
    option2Ids: refIds("option_2"),
    option2Titles: refTitles("option_2"),
    discountAmounts,
  };
}

function parseMetafield(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (Array.isArray(parsed.bundles)) {
      return parsed.bundles.map((b) => ({
        id: b.id,
        name: b.name ?? "",
        productIds: Array.isArray(b.productIds) ? b.productIds : [],
        productTitles: Array.isArray(b.productTitles) ? b.productTitles : [],
        option1Ids: Array.isArray(b.option1Ids) ? b.option1Ids : [],
        option1Titles: Array.isArray(b.option1Titles) ? b.option1Titles : [],
        option2Ids: Array.isArray(b.option2Ids) ? b.option2Ids : [],
        option2Titles: Array.isArray(b.option2Titles) ? b.option2Titles : [],
        discountAmounts: {
          ...emptyDiscountAmounts(),
          ...(b.discountAmounts ?? {}),
        },
      }));
    }
  } catch {}
  return [];
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
    const classes = discounts?.discountClasses?.value ?? [];
    if (!classes.includes("order")) {
      discounts?.updateDiscountClasses?.([...classes, "order"]);
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

                <s-stack gap="extraSmall">
                  <s-text emphasis="bold">Products (all required)</s-text>
                  {bundle.productTitles.length ? (
                    bundle.productTitles.map((t, i) => (
                      <s-text key={i}>• {t}</s-text>
                    ))
                  ) : (
                    <s-text tone="critical">No products set on this bundle.</s-text>
                  )}
                </s-stack>

                {bundle.option1Titles.length ? (
                  <s-stack gap="extraSmall">
                    <s-text emphasis="bold">Option 1 (customer picks one)</s-text>
                    {bundle.option1Titles.map((t, i) => (
                      <s-text key={i}>• {t}</s-text>
                    ))}
                  </s-stack>
                ) : null}

                {bundle.option2Titles.length ? (
                  <s-stack gap="extraSmall">
                    <s-text emphasis="bold">Option 2 (customer picks one)</s-text>
                    {bundle.option2Titles.map((t, i) => (
                      <s-text key={i}>• {t}</s-text>
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
