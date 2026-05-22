import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useMemo, useState} from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

const SUPPORTED_CURRENCIES = ["AUD", "NZD", "USD", "CAD", "EUR", "GBP", "AED"];

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function normalizeTag(value) {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function emptyDiscountAmounts() {
  return SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = 0;
    return acc;
  }, {});
}

function parseMetafield(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (Array.isArray(parsed.bundles)) {
      return parsed.bundles.map((b) => {
        const amounts = emptyDiscountAmounts();
        if (b.discountAmounts && typeof b.discountAmounts === "object") {
          for (const code of SUPPORTED_CURRENCIES) {
            amounts[code] = Number(b.discountAmounts[code] ?? 0);
          }
        } else if (typeof b.discountAmount === "number") {
          // Migrate older single-amount shape onto AUD as primary currency.
          amounts.AUD = Number(b.discountAmount);
        }
        return {
          id: b.id ?? newId(),
          name: b.name ?? "",
          tags: Array.isArray(b.tags) ? b.tags.filter(Boolean) : [],
          discountAmounts: amounts,
        };
      });
    }
  } catch {}
  return [];
}

function App() {
  const {applyMetafieldChange, data, discounts} = shopify;

  const initialBundles = useMemo(
    () =>
      parseMetafield(
        data?.metafields?.find((m) => m.key === "function-configuration")
          ?.value,
      ),
    [data?.metafields],
  );

  const [bundles, setBundles] = useState(initialBundles);
  const [tagInputs, setTagInputs] = useState({});
  const [error, setError] = useState();

  useEffect(() => {
    const classes = discounts?.discountClasses?.value ?? [];
    if (!classes.includes("order")) {
      discounts?.updateDiscountClasses?.([...classes, "order"]);
    }
  }, []);

  function handleSubmit(event) {
    const flatTags = Array.from(
      new Set(bundles.flatMap((b) => b.tags)),
    );
    event.waitUntil?.(
      applyMetafieldChange({
        type: "updateMetafield",
        namespace: "$app",
        key: "function-configuration",
        value: JSON.stringify({tags: flatTags, bundles}),
        valueType: "json",
      }),
    );
  }

  function handleReset() {
    setBundles(initialBundles);
    setTagInputs({});
    setError(undefined);
  }

  function addBundle() {
    setBundles((prev) => [
      ...prev,
      {
        id: newId(),
        name: "",
        tags: [],
        discountAmounts: emptyDiscountAmounts(),
      },
    ]);
  }

  function updateBundle(id, patch) {
    setBundles((prev) =>
      prev.map((b) => (b.id === id ? {...b, ...patch} : b)),
    );
  }

  function updateBundleAmount(id, code, value) {
    setBundles((prev) =>
      prev.map((b) =>
        b.id === id
          ? {
              ...b,
              discountAmounts: {
                ...b.discountAmounts,
                [code]: Number(value || 0),
              },
            }
          : b,
      ),
    );
  }

  function removeBundle(id) {
    setBundles((prev) => prev.filter((b) => b.id !== id));
    setTagInputs((prev) => {
      const next = {...prev};
      delete next[id];
      return next;
    });
  }

  function addTagToBundle(bundleId) {
    const raw = tagInputs[bundleId] ?? "";
    const tag = normalizeTag(raw);
    if (!tag) return;
    setBundles((prev) =>
      prev.map((b) => {
        if (b.id !== bundleId) return b;
        if (b.tags.includes(tag)) return b;
        return {...b, tags: [...b.tags, tag]};
      }),
    );
    setTagInputs((prev) => ({...prev, [bundleId]: ""}));
  }

  function removeTagFromBundle(bundleId, tag) {
    setBundles((prev) =>
      prev.map((b) =>
        b.id === bundleId ? {...b, tags: b.tags.filter((t) => t !== tag)} : b,
      ),
    );
  }

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
            Each bundle requires one cart item per tag. Any product carrying
            the tag fills that slot — useful when customers can pick between
            flavours or variants. When a cart qualifies for multiple bundles,
            the highest-discount bundle is applied first and its items are
            consumed before lower bundles are evaluated. Discounts are charged
            in the cart's checkout currency; leave a currency at 0 to skip
            the bundle for that currency.
          </s-text>

          {bundles.length === 0 ? (
            <s-text tone="subdued">No bundles configured yet.</s-text>
          ) : null}

          {bundles.map((bundle, index) => (
            <s-section
              key={bundle.id}
              heading={bundle.name || `Bundle ${index + 1}`}
            >
              <s-stack gap="base">
                <s-text-field
                  label="Bundle name"
                  value={bundle.name}
                  placeholder="e.g. Platinum Bundle"
                  onInput={(e) =>
                    updateBundle(bundle.id, {name: e.target.value})
                  }
                />

                <s-stack gap="extraSmall">
                  <s-text>Discount amount per currency</s-text>
                  {SUPPORTED_CURRENCIES.map((code) => (
                    <s-number-field
                      key={code}
                      label={code}
                      min={0}
                      step={1}
                      value={String(bundle.discountAmounts?.[code] ?? 0)}
                      onChange={(e) =>
                        updateBundleAmount(
                          bundle.id,
                          code,
                          e.currentTarget.value,
                        )
                      }
                    />
                  ))}
                </s-stack>

                <s-stack gap="extraSmall">
                  <s-text>Required product tags (one item per tag)</s-text>

                  {bundle.tags.length === 0 ? (
                    <s-text tone="subdued">No tags added.</s-text>
                  ) : (
                    bundle.tags.map((tag) => (
                      <s-stack
                        key={tag}
                        direction="inline"
                        alignItems="center"
                        justifyContent="space-between"
                      >
                        <s-badge tone="info">{tag}</s-badge>
                        <s-button
                          variant="tertiary"
                          onClick={() =>
                            removeTagFromBundle(bundle.id, tag)
                          }
                        >
                          <s-icon type="x-circle" />
                        </s-button>
                      </s-stack>
                    ))
                  )}

                  <s-text-field
                    label="Add tag"
                    value={tagInputs[bundle.id] ?? ""}
                    placeholder="e.g. promo-bundle--antibac"
                    onInput={(e) =>
                      setTagInputs((prev) => ({
                        ...prev,
                        [bundle.id]: e.target.value,
                      }))
                    }
                  />
                  <s-button onClick={() => addTagToBundle(bundle.id)}>
                    Add tag
                  </s-button>
                </s-stack>

                <s-divider />

                <s-button
                  variant="tertiary"
                  tone="critical"
                  onClick={() => removeBundle(bundle.id)}
                >
                  Remove bundle
                </s-button>
              </s-stack>
            </s-section>
          ))}

          <s-button onClick={addBundle}>Add bundle</s-button>
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}
