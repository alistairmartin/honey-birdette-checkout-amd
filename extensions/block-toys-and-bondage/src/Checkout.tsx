import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  useBuyerJourneyIntercept,
  useShippingAddress,
  useCartLines,
  useTranslate,
} from '@shopify/ui-extensions/checkout/preact';

type CartLine = ReturnType<typeof useCartLines>[number];

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const address = useShippingAddress();
  const cartLines = useCartLines();
  const translate = useTranslate();

  const [showBanner, setShowBanner] = useState(false);
  const [restrictedItems, setRestrictedItems] = useState<CartLine[]>([]);

  const restrictedCountries = ["EG", "SA", "AE", "QA", "OM", "BH", "YE", "IN", "PK", "MV", "TH", "VN", "ID", "MY", "SY", "IQ", "AF", "TR"];
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
    try {
      for (const item of restrictedItems) {
        const change = {
          id: item.id,
          type: "removeCartLine" as const,
          quantity: item.quantity,
        };

        console.log("Applying change:", change);

        const result = await shopify.applyCartLinesChange(change);

        console.log("Result of applying cart lines change:", result);

        if (result.type !== 'success') {
          console.error("Failed to remove restricted item:", result);
        }
      }

      console.log("Restricted items removed.");
      setShowBanner(false);
    } catch (error) {
      console.error("Error removing restricted items:", error);
    }
  };

  return showBanner ? (
    <s-banner heading="Restricted items in cart" tone="critical">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          {translate('please-remove')}
          <s-text type="strong">{translate('toys-or-bondage')}</s-text>
          <s-text>{translate('description')}</s-text>
        </s-paragraph>
        <s-box>
          <s-button variant="primary" onClick={removeRestrictedItems}>
            {translate('remove-items')}
          </s-button>
        </s-box>
      </s-stack>
    </s-banner>
  ) : null;
}
