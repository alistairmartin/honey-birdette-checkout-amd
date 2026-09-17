import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useState, useMemo} from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

const EMPTY = {
  products: [],
  shippingTitles: "",
  includeCountries: "",
  excludeCountries: "",
  message: "FREE Shipping",
};

function parseConfig(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    const ids = Array.isArray(parsed.productIds) ? parsed.productIds : [];
    const titles = Array.isArray(parsed.productTitles) ? parsed.productTitles : [];
    return {
      products: ids.map((id, i) => ({id, title: titles[i] || id})),
      shippingTitles: (parsed.shippingTitles || []).join("\n"),
      includeCountries: (parsed.includeCountries || []).join(", "),
      excludeCountries: (parsed.excludeCountries || []).join(", "),
      message: typeof parsed.message === "string" ? parsed.message : EMPTY.message,
    };
  } catch {
    return EMPTY;
  }
}

function splitLines(text) {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitCodes(text) {
  return text
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function toMetafieldValue(state) {
  return JSON.stringify({
    productIds: state.products.map((p) => p.id),
    productTitles: state.products.map((p) => p.title),
    shippingTitles: splitLines(state.shippingTitles),
    includeCountries: splitCodes(state.includeCountries),
    excludeCountries: splitCodes(state.excludeCountries),
    message: state.message.trim() || EMPTY.message,
  });
}

function App() {
  const {applyMetafieldChange, data, resourcePicker} = shopify;

  const initial = useMemo(
    () =>
      parseConfig(
        data?.metafields?.find((m) => m.key === "function-configuration")?.value,
      ),
    [data?.metafields],
  );

  const [state, setState] = useState(initial);
  const set = (key) => (e) => setState((s) => ({...s, [key]: e.target.value}));

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

  const serialized = toMetafieldValue(state);

  return (
    <s-function-settings onSubmit={handleSubmit} onReset={handleReset}>
      <s-box display="none">
        <s-text-field
          label=""
          name="config"
          value={serialized}
          defaultValue={toMetafieldValue(initial)}
        />
      </s-box>

      <s-section heading="Qualifying products">
        <s-stack gap="base">
          <s-text>
            Shipping becomes free when any of these products is in the cart.
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
        </s-stack>
      </s-section>

      <s-section heading="Shipping rates to make free">
        <s-stack gap="base">
          <s-text-area
            label="Shipping rate names (one per line)"
            name="shippingTitles"
            value={state.shippingTitles}
            rows={3}
            details="Must match the rate name exactly as it appears at checkout, e.g. Express Delivery"
            onInput={set("shippingTitles")}
          />
          <s-text-field
            label="Checkout label"
            name="message"
            value={state.message}
            details="Shown next to the discounted rate at checkout."
            onInput={set("message")}
          />
        </s-stack>
      </s-section>

      <s-section heading="Countries (optional)">
        <s-stack gap="base">
          <s-text-field
            label="Only these countries"
            name="includeCountries"
            value={state.includeCountries}
            placeholder="e.g. GB, DE, FR"
            details="Two-letter country codes. Leave empty to allow every country."
            onInput={set("includeCountries")}
          />
          <s-text-field
            label="Never these countries"
            name="excludeCountries"
            value={state.excludeCountries}
            placeholder="e.g. CH"
            details="Two-letter country codes that never receive the free rate."
            onInput={set("excludeCountries")}
          />
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}
