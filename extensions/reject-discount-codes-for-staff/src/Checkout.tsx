import React, { useEffect, useState } from "react";
import {
  reactExtension,
  useDiscountCodes,
  useAppliedGiftCards,
  useBuyerJourneyIntercept,
  Banner,
  BlockStack,
  TextBlock,
  View,
  Text,
  useTranslate,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension("purchase.checkout.block.render", () => <App />);

function App() {
  const discountCodes = useDiscountCodes();
  const appliedGiftCards = useAppliedGiftCards(); // returns an array of AppliedGiftCard objects

  // Gift card endings that should block checkout if combined with a discount code
  const blockedEnds = ["HB51", "HB52", "HB53", "HB54", "HB61", "HB62", "HB63", "HB64"];

  // Track whether checkout should be blocked
  const [shouldBlock, setShouldBlock] = useState(true);

  console.log('discountcodes!'); 
  console.log(discountCodes);

  useEffect(() => {
    console.log("Discount Codes:", discountCodes);
    console.log("Applied Gift Cards:", appliedGiftCards);
    console.log("Blocked gift card endings:", blockedEnds);

    const discountApplied = discountCodes.length > 0;
    const giftCardBlocked =
    appliedGiftCards?.some((card) => {
      const lastChars = card.lastCharacters?.trim().toLowerCase();
      console.log("Gift card lastCharacters (lowercased):", lastChars);
      return blockedEnds.some((ending) => {
        const lowerEnding = ending.trim().toLowerCase();
        console.log(`Comparing "${lastChars}" to "${lowerEnding}"`);
        return lastChars === lowerEnding;
      });
    });

    console.log("Discount applied:", discountApplied);
    console.log("Gift card with blocked ending found:", giftCardBlocked);

    if (discountApplied && giftCardBlocked) {
      console.log("Blocking checkout: Discount code used with a restricted gift card.");
      setShouldBlock(true);
    } else {
      console.log("No blocking conditions met. Allowing checkout progress.");
      setShouldBlock(false);
    }
  }, [discountCodes, appliedGiftCards]);

  // Intercept the buyer journey to block checkout progress if needed
  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    console.log("Buyer journey intercept invoked. Can block progress:", canBlockProgress);

    if (!shouldBlock) {
      console.log("No conditions to block. Allowing checkout progress.");
      return { behavior: "allow" };
    }

    if (canBlockProgress) {
      console.log("Blocking checkout progress due to discount code and staff gift card conflict.");
      return {
        behavior: "block",
        reason: "Discount code and staff gift card conflict",
        errors: [
          {
            message:
              "Sorry Honey, you can't use discount codes with staff Gift Cards. Please remove either the discount code or the gift card. "
          },
        ],
        perform: (result) => {
          if (result.behavior === "block") {
            console.log("Checkout progress successfully blocked.");
          }
        },
      };
    }

    console.log("Cannot block progress. Allowing checkout progress.");
    return { behavior: "allow" };
  });

  // Render a critical banner if we are blocking checkout
  return shouldBlock ? (
    <Banner title="Cannot Use Staff Gift Cards with Discount Codes" status="critical">
      <BlockStack spacing="base">
        <View>
          <TextBlock>
            <Text>
              Sorry Honey, you can't use discount codes with staff Gift Cards. Please remove either the discount code or the gift card. 
            </Text>
          </TextBlock>
        </View>
      </BlockStack>
    </Banner>
  ) : null;
}