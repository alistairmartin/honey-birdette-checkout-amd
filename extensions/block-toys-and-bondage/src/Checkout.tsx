import {
  reactExtension,
  useBuyerJourneyIntercept,
  useShippingAddress,
  useCartLines,
  Banner,
  BlockStack,
  TextBlock,
  View,
  Button,
  Text,
  useApplyCartLinesChange,
  useTranslate,
} from '@shopify/ui-extensions-react/checkout';
import { useEffect, useState } from 'react';

export default reactExtension(
  'purchase.checkout.delivery-address.render-before',
  () => <Extension />,
);

function Extension() {
  const address = useShippingAddress();
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const translate = useTranslate();
  const [showBanner, setShowBanner] = useState(false);
  const [restrictedItems, setRestrictedItems] = useState([]);

  const restrictedCountries = [
    "EG", "SA", "AE", "QA", "OM", "BH", "YE", "IN", "PK", "MV", 
    "TH", "VN", "ID", "MY", "SY", "IQ", "AF", "TR"
  ];
  const restrictedProductTypes = ["Toys", "Bondage"];

  useEffect(() => {
    const checkRestrictions = () => {
      const countryCode = address?.countryCode;
      console.log("Shipping country code:", countryCode);
      console.log("Address:", address);

      const restrictedItems = cartLines.filter(line => 
        restrictedProductTypes.includes(line.merchandise.product.productType)
      );
      console.log("Restricted items in cart:", restrictedItems);

      if (restrictedCountries.includes(countryCode) && restrictedItems.length > 0) {
        console.log("Restrictions apply. Blocking checkout progress.");
        setShowBanner(true);
        setRestrictedItems(restrictedItems);
      } else {
        console.log("No restrictions apply. Allowing checkout progress.");
        setShowBanner(false);
      }
    };

    checkRestrictions();
  }, [cartLines, address?.countryCode]);

  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    console.log("Buyer journey intercept invoked. Can block progress:", canBlockProgress);
    if (!showBanner) {
      console.log("No banner to show. Allowing progress.");
      return { behavior: "allow" };
    }

    if (canBlockProgress) {
      console.log("Blocking checkout progress due to restricted items.");
      return {
        behavior: "block",
        reason: "Restricted items in cart",
        errors: [
          {
            message: "Please remove Toys or Bondage items from your cart before proceeding.",
          },
        ],
        perform: (result) => {
          if (result.behavior === "block") {
            console.log("Checkout progress blocked.");
          }
        },
      };
    }

    console.log("Allowing checkout progress.");
    return { behavior: "allow" };
  });

  const removeRestrictedItems = async () => {
    const changes = restrictedItems.map(item => {
      console.log("👑 Item to be removed:", item);
      return {
        id: item.id,
        type: "remove"
      };
    });
    console.log("Changes to apply:", changes);
  
    try {
      await applyCartLinesChange(changes);
      console.log("Restricted items removed.");
      setShowBanner(false);
    } catch (error) {
      console.error("Error removing restricted items:", error);
    }
  };
  

  return showBanner ? (
      <Banner title="Restricted items in cart" status="critical" >
        <BlockStack spacing="base">
        <View>

          <TextBlock>
          {translate('please-remove')}
          <Text emphasis="bold">{translate('toys-or-bondage')}</Text>
          <Text>{translate('description')}</Text>
          </TextBlock>
        </View>
        <View>
          <Button onPress={removeRestrictedItems}>{translate('remove-items')}</Button>
        </View>
      </BlockStack>

      </Banner>
  ) : null;
}
