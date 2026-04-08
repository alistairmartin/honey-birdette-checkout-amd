import "@shopify/ui-extensions/preact";
import {render} from "preact";

export default async () => {
  render(<App />, document.body);
};

function App() {
  const {i18n} = shopify;

  return (
    <s-function-settings onSubmit={() => {}}>
      <s-section>
        <s-text>{i18n.translate("description")}</s-text>
      </s-section>
    </s-function-settings>
  );
}
