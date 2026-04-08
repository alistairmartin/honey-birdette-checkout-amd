import { reactExtension } from "@shopify/ui-extensions-react/admin";
import { App } from "./App";

const TARGET = "admin.discounts.details.render";

export default reactExtension(TARGET, () => <App target={TARGET} />);
