import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useSettings } from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<App />, document.body);
}

function App() {
  const {
    title: merchantTitle,
    description,
    collapsible,
    status: merchantStatus,
  } = useSettings();

  const status = /** @type {'info' | 'success' | 'warning' | 'critical'} */ (
    merchantStatus ?? "info"
  );
  const title = String(merchantTitle ?? "Custom Banner");

  return (
    <s-banner heading={title} tone={status} collapsible={Boolean(collapsible)}>
      {description}
    </s-banner>
  );
}
