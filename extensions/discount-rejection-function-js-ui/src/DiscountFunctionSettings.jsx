import "@shopify/ui-extensions/preact";
import {render} from "preact";

export default async () => {
  render(<App />, document.body);
};

function App() {
  return (
    <s-section heading="Rejection Settings">
      <s-text>Hello - extension is working</s-text>
    </s-section>
  );
}
