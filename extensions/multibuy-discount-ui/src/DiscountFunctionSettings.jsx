import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useMemo, useState} from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

const SUPPORTED_CURRENCIES = [
  "AUD", "NZD", "USD", "CAD", "EUR", "GBP", "AED", "HKD", "SGD",
];

const emptyPrices = () =>
  SUPPORTED_CURRENCIES.reduce((acc, code) => {
    acc[code] = "";
    return acc;
  }, {});

const emptyTier = (quantity = "") => ({quantity: String(quantity), prices: emptyPrices()});

function parseConfig(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    const ids = Array.isArray(parsed.productIds) ? parsed.productIds : [];
    const titles = Array.isArray(parsed.productTitles) ? parsed.productTitles : [];
    const tiers = Array.isArray(parsed.tiers) ? parsed.tiers : [];
    return {
      products: ids.map((id, i) => ({id, title: titles[i] || id})),
      message: typeof parsed.message === "string" ? parsed.message : "",
      tiers: tiers.map((t) => ({
        quantity: t.quantity ? String(t.quantity) : "",
        prices: SUPPORTED_CURRENCIES.reduce((acc, code) => {
          const v = t.prices?.[code];
          acc[code] = typeof v === "number" && v > 0 ? String(v) : "";
          return acc;
        }, {}),
      })),
    };
  } catch {
    return {products: [], message: "", tiers: []};
  }
}

function toMetafieldValue(state) {
  return JSON.stringify({
    productIds: state.products.map((p) => p.id),
    productTitles: state.products.map((p) => p.title),
    message: state.message.trim(),
    tiers: state.tiers.map((t) => ({
      quantity: Number.parseInt(t.quantity, 10) || 0,
      // Blank or 0 means the offer is off in that currency.
      prices: SUPPORTED_CURRENCIES.reduce((acc, code) => {
        const n = Number(t.prices[code]);
        if (n > 0) acc[code] = n;
        return acc;
      }, {}),
    })),
  });
}

function App() {
  const {applyMetafieldChange, data, discounts, resourcePicker} = shopify;

  const initial = useMemo(
    () =>
      parseConfig(
        data?.metafields?.find((m) => m.key === "function-configuration")?.value,
      ),
    [data?.metafields],
  );

  const [state, setState] = useState(
    initial.tiers.length ? initial : {...initial, tiers: [emptyTier(2)]},
  );

  useEffect(() => {
    // This function only emits product discounts.
    const classes = discounts?.discountClasses?.value ?? [];
    const isProductOnly = classes.length === 1 && classes[0] === "product";
    if (!isProductOnly) {
      discounts?.updateDiscountClasses?.(["product"]);
    }
  }, []);

  async function pickProducts() {
    const selected = await resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      selectionIds: state.products.map((p) => ({id: p.id})),
    });
    if (!selected) return;
    setState((s) => ({
      ...s,
      products: selected.map((p) => ({id: p.id, title: p.title})),
    }));
  }

  function removeProduct(id) {
    setState((s) => ({...s, products: s.products.filter((p) => p.id !== id)}));
  }

  function updateTier(index, patch) {
    setState((s) => ({
      ...s,
      tiers: s.tiers.map((t, i) => (i === index ? {...t, ...patch} : t)),
    }));
  }

  function setTierPrice(index, code, value) {
    setState((s) => ({
      ...s,
      tiers: s.tiers.map((t, i) =>
        i === index ? {...t, prices: {...t.prices, [code]: value}} : t,
      ),
    }));
  }

  function addTier() {
    setState((s) => ({...s, tiers: [...s.tiers, emptyTier()]}));
  }

  function removeTier(index) {
    setState((s) => ({...s, tiers: s.tiers.filter((_, i) => i !== index)}));
  }

  function handleSubmit(event) {
    event.waitUntil?.(
      applyMetafieldChange({
        type: "updateMetafield",
        namespace: "$app",
        key: "function-configuration",
        value: toMetafieldValue(state),
        valueType: "json",
      }),
    );
  }

  function handleReset() {
    setState(initial);
  }

  return (
    <s-function-settings onSubmit={handleSubmit} onReset={handleReset}>
      <s-box display="none">
        <s-text-field
          label=""
          name="config"
          value={toMetafieldValue(state)}
          defaultValue={toMetafieldValue(initial)}
        />
      </s-box>

      <s-section heading="Products">
        <s-stack gap="base">
          <s-text>
            Customers can mix any of these products to reach a tier, e.g. 1 Red +
            1 Ivory counts as 2.
          </s-text>
          {state.products.length === 0 ? (
            <s-text color="subdued">No products selected.</s-text>
          ) : (
            <s-stack gap="small-200">
              {state.products.map((p) => (
                <s-stack key={p.id} direction="inline" gap="base" alignItems="center">
                  <s-text>{p.title}</s-text>
                  <s-button variant="tertiary" onClick={() => removeProduct(p.id)}>
                    Remove
                  </s-button>
                </s-stack>
              ))}
            </s-stack>
          )}
          <s-button onClick={pickProducts}>
            {state.products.length === 0 ? "Select products" : "Change products"}
          </s-button>
          <s-text-field
            label="Checkout label"
            name="message"
            value={state.message}
            placeholder="Multibuy offer"
            details="Shown next to the discount at checkout."
            onInput={(e) => setState((s) => ({...s, message: e.target.value}))}
          />
        </s-stack>
      </s-section>

      <s-section heading="Price tiers">
        <s-stack gap="base">
          <s-text>
            Enter the bundle price, e.g. quantity 2 and AUD 70 for "2 for $70".
            Leave a currency blank to switch the offer off in that market. The
            biggest tier is filled first, so 8 items = one 6-pack + one 2-pack.
          </s-text>
          {state.tiers.map((tier, index) => (
            <s-section
              key={index}
              heading={tier.quantity ? `${tier.quantity} for` : "New tier"}
            >
              <s-stack gap="base">
                <s-number-field
                  label="Quantity"
                  name={`tier-${index}-quantity`}
                  value={tier.quantity}
                  min={2}
                  step={1}
                  onInput={(e) => updateTier(index, {quantity: e.target.value})}
                />
                <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                  {SUPPORTED_CURRENCIES.map((code) => (
                    <s-money-field
                      key={code}
                      label={`${code} bundle price`}
                      name={`tier-${index}-${code}`}
                      value={tier.prices[code]}
                      onInput={(e) => setTierPrice(index, code, e.target.value)}
                    />
                  ))}
                </s-grid>
                <s-button
                  variant="tertiary"
                  tone="critical"
                  onClick={() => removeTier(index)}
                >
                  Remove tier
                </s-button>
              </s-stack>
            </s-section>
          ))}
          <s-button onClick={addTier}>Add tier</s-button>
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}
