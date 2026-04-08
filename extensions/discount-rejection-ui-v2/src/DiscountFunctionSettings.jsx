import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useState, useMemo} from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

const DEFAULT_MESSAGE = "Sorry Honey, discounts codes not allowed on Sale, Gift Cards or Swimwear items.";

function parseMetafield(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (Array.isArray(parsed.rules) && parsed.rules.length > 0) {
      return parsed.rules;
    }
  } catch {}
  return [];
}

function App() {
  const {applyMetafieldChange, data} = shopify;

  const initialRules = useMemo(
    () =>
      parseMetafield(
        data?.metafields?.find((m) => m.key === "function-configuration")?.value,
      ),
    [data?.metafields],
  );

  const [rules, setRules] = useState(initialRules);
  const [tagInput, setTagInput] = useState("");
  const [messageInput, setMessageInput] = useState(DEFAULT_MESSAGE);
  const [error, setError] = useState();

  function handleSubmit(event) {
    event.waitUntil?.(
      applyMetafieldChange({
        type: "updateMetafield",
        namespace: "$app",
        key: "function-configuration",
        value: JSON.stringify({
          tags: rules.map((r) => r.tag),
          rules,
        }),
        valueType: "json",
      }),
    );
  }

  function handleReset() {
    setRules(initialRules);
    setTagInput("");
    setMessageInput(DEFAULT_MESSAGE);
    setError(undefined);
  }

  function addRule() {
    const tag = tagInput.trim().toLowerCase().replace(/\s+/g, "-");
    const message = messageInput.trim();
    if (!tag || !message) return;
    if (rules.some((r) => r.tag === tag)) return;
    setRules([...rules, {tag, message}]);
    setTagInput("");
    setMessageInput(DEFAULT_MESSAGE);
  }

  function removeRule(tag) {
    setRules(rules.filter((r) => r.tag !== tag));
  }

  return (
    <s-function-settings onSubmit={handleSubmit} onReset={handleReset}>
      {/* Hidden field so s-function-settings detects dirty state when rules change */}
      <s-box display="none">
        <s-text-field
          label=""
          name="rules"
          value={JSON.stringify(rules)}
          defaultValue={JSON.stringify(initialRules)}
        />
      </s-box>
      <s-section heading="Rejection Rules">
        <s-stack gap="base">
          {error ? <s-banner tone="critical">{error}</s-banner> : null}

          <s-text>
            Reject discount codes when the cart contains a product with any of
            these tags.
          </s-text>

          {rules.map((rule) => (
            <s-stack
              key={rule.tag}
              direction="inline"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-stack gap="extraSmall">
                <s-badge tone="info">{rule.tag}</s-badge>
                <s-text>{rule.message}</s-text>
              </s-stack>
              <s-button variant="tertiary" onClick={() => removeRule(rule.tag)}>
                <s-icon type="x-circle" />
              </s-button>
            </s-stack>
          ))}

          <s-divider />

          <s-text-field
            label="Product Tag (Only 1)"
            name="tag"
            value={tagInput}
            placeholder="e.g. bf-sale-excluded"
            onInput={(e) => setTagInput(e.target.value)}
          />
          <s-text-field
            label="Rejection Message (120 Character Limit)"
            name="message"
            value={messageInput}
            multiline="2"
            onInput={(e) => setMessageInput(e.target.value)}
          />
          <s-button onClick={addRule}>Add Rule</s-button>
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}
