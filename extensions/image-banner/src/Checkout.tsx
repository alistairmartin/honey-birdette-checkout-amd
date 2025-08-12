import {
  reactExtension,
  useSettings,
  Image,
  useApi,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension("purchase.checkout.block.render", () => (
  <Extension />
));

function Extension() {
  const { extension } = useApi();
  const { url } = useSettings();

  const urlSettings = url ?? 'https://cdn.shopify.com/s/files/1/0569/7873/5279/files/checkout.jpg';

  return (
   <Image source={urlSettings} />
  );
}