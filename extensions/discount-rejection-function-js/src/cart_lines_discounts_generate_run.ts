import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from '../generated/api';

interface FunctionConfig {
  tags?: string[];
  message?: string;
}

const DEFAULT_TAGS = ['stop-discount-code'];
const DEFAULT_MESSAGE = 'Discount codes cannot be applied to this order.';

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  const configValue = input.discount.metafield?.value;
  const config: FunctionConfig = configValue ? JSON.parse(configValue) : {};
  const activeTags = config.tags?.length ? config.tags : DEFAULT_TAGS;
  const message = config.message ?? DEFAULT_MESSAGE;

  const hasRestrictedProduct = input.cart.lines.some((line) => {
    const merchandise = line.merchandise;
    if (merchandise.__typename === 'ProductVariant') {
      return merchandise.product.hasTags.some(
        ({tag, hasTag}) => hasTag && activeTags.includes(tag),
      );
    }
    return false;
  });

  if (!hasRestrictedProduct) {
    return {operations: []};
  }

  const codesToReject = input.enteredDiscountCodes
    .filter((dc) => dc.rejectable)
    .map((dc) => ({code: dc.code}));

  if (!codesToReject.length) {
    return {operations: []};
  }

  return {
    operations: [
      {
        enteredDiscountCodesReject: {
          message,
          codes: codesToReject,
        },
      },
    ],
  };
}
