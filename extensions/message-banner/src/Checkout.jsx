import React from "react";
import {
  reactExtension,
  Banner,
  useSettings,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension("purchase.checkout.block.render", () => <App />);

function App() {
  const {title: merchantTitle, description, collapsible, status: merchantStatus} = useSettings();

  const status = merchantStatus ?? 'info';
  const title = merchantTitle ?? 'Custom Banner';

  return (
    <Banner title={title} status={status} collapsible={collapsible}>
      {description}
    </Banner>
  );

}