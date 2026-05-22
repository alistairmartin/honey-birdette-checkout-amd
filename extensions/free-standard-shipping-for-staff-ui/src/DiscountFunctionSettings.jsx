import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useState, useMemo} from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

function parseConfig(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return typeof parsed.shippingTitle === "string" ? parsed.shippingTitle : "";
  } catch {
    return "";
  }
}

function App() {
  const {applyMetafieldChange, data} = shopify;

  const initialTitle = useMemo(
    () =>
      parseConfig(
        data?.metafields?.find((m) => m.key === "function-configuration")?.value,
      ),
    [data?.metafields],
  );

  const [shippingTitle, setShippingTitle] = useState(initialTitle);

  function handleSubmit(event) {
    event.waitUntil?.(
      applyMetafieldChange({
        type: "updateMetafield",
        namespace: "$app",
        key: "function-configuration",
        value: JSON.stringify({shippingTitle}),
        valueType: "json",
      }),
    );
  }

  function handleReset() {
    setShippingTitle(initialTitle);
  }

  return (
    <s-function-settings onSubmit={handleSubmit} onReset={handleReset}>
      <s-box display="none">
        <s-text-field
          label=""
          name="shippingTitle"
          value={shippingTitle}
          defaultValue={initialTitle}
        />
      </s-box>
      <s-section heading="Free Standard Shipping for Staff">
        <s-stack gap="base">
          <s-text>
            Applies 100% off the specified shipping rate for customers with a
            @honeybirdette.com or @honeybirdette.com.au email address.
          </s-text>
          <s-text-field
            label="Shipping Rate Name"
            name="shippingTitleVisible"
            value={shippingTitle}
            placeholder="e.g. Standard Shipping (2-5 Days)"
            helpText="Must match the shipping rate name exactly as it appears at checkout."
            onInput={(e) => setShippingTitle(e.target.value)}
          />
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}
