import {
  reactExtension,
  Banner,
  BlockStack,
  Checkbox,
  Text,
  useApi,
  useAppMetafields,
  useApplyMetafieldsChange,
  useInstructions,
  useTranslate,
} from "@shopify/ui-extensions-react/checkout";

// 1. Choose an extension target
export default reactExtension("purchase.checkout.block.render", () => (
  <Extension />
));

function Extension() {
  const translate = useTranslate();
  const { extension } = useApi();
  const instructions = useInstructions();
  const applyMetafieldChange = useApplyMetafieldsChange();

  // 2. Check instructions for feature availability, see https://shopify.dev/docs/api/checkout-ui-extensions/apis/cart-instructions for details
  if (!instructions.metafields.canSetCartMetafields) {
    return (
      <Banner title="tiered-GWP" status="warning">
        {translate("metafieldChangesAreNotSupported")}
      </Banner>
    );
  }

  const freeGiftRequested = useAppMetafields().find(
    (appMetafield) =>
      appMetafield.target.type === "cart" &&
      appMetafield.metafield.namespace === "$app" &&
      appMetafield.metafield.key === "requestedFreeGift",
  );

  // 3. Render a UI
  return (
    <BlockStack border={"dotted"} padding={"tight"}>
      <Banner title="tiered-GWP">
        {translate("welcome", {
          target: <Text emphasis="italic">{extension.target}</Text>,
        })}
      </Banner>
      <Checkbox
        checked={freeGiftRequested?.metafield?.value === "true"}
        onChange={onCheckboxChange}
      >
        {translate("iWouldLikeAFreeGiftWithMyOrder")}
      </Checkbox>
    </BlockStack>
  );

  async function onCheckboxChange(isChecked) {
    // 4. Call the API to modify checkout
    const result = await applyMetafieldChange({
      type: "updateCartMetafield",
      metafield: {
        namespace: "$app",
        key: "requestedFreeGift",
        value: isChecked ? "true" : "false",
        type: "boolean",
      },
    });
    console.log("applyMetafieldChange result", result);
  }
}