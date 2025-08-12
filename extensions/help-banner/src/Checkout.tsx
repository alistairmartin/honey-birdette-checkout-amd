import {
  reactExtension,
  BlockStack,
  Text,
  TextBlock,
  Icon,
  View,
  useApi,
  useSettings,
  InlineLayout,
  useTranslate,
  Heading,
  Link,
} from "@shopify/ui-extensions-react/checkout";

// 1. Choose an extension target
export default reactExtension("purchase.checkout.block.render", () => (
  <Extension />
));

function Extension() {
  const translate = useTranslate();
  const { extension } = useApi();
  const { title, description, linkurl, linktext } = useSettings();

  const titleSetting = title ?? 'Title';
  const descriptionSetting = description ?? 'Descriptin';

    const linkUrl = linkurl ?? 'https://eu.honeybirdette.com/pages/contact-us';
  const linkText = linktext ?? 'Link Text';

  return (
   <BlockStack>
    
      <View>
          <InlineLayout columns={['auto', 'fill']} spacing="extraTight" blockAlignment="center">
            <Icon source="mobile" appearance="base" />
            <Text emphasis="bold">{ titleSetting }</Text>
          </InlineLayout>
        </View>

        <View>
          <TextBlock>{descriptionSetting}</TextBlock>
        </View>

         <View>
          <Link to={linkUrl}>{ linkText }</Link>
        </View>

    </BlockStack>
  );


}