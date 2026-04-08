import {
  OrderDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from '../generated/api';

const DISCOUNT_PERCENTAGE = 10;
const DISCOUNT_LIMIT = 4;

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.cart.lines.length) {
    return {operations: []};
  }

  const qualifyingLines = input.cart.lines.filter((line) => {
    const isSpecialBundle =
      line.merchandise.__typename === 'ProductVariant' &&
      line.merchandise.product.hasAnyTag;
    const hasByoBundleAttr = line.attribute?.value != null;
    return isSpecialBundle && hasByoBundleAttr;
  });

  if (qualifyingLines.length < DISCOUNT_LIMIT) {
    return {operations: []};
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: 'BUILD YOUR ROUTINE',
              targets: [
                {
                  orderSubtotal: {
                    excludedCartLineIds: [],
                  },
                },
              ],
              value: {
                percentage: {
                  value: DISCOUNT_PERCENTAGE,
                },
              },
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
