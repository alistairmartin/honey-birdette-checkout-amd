import { reactExtension } from "@shopify/ui-extensions-react/admin";
import { App } from "./App";

const TARGET = "admin.discounts.create.render";

export default reactExtension(TARGET, () => <App target={TARGET} />);
