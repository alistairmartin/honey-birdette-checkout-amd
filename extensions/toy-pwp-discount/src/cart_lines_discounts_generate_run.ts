import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

interface FunctionConfig {
  // Master switch. When false (or omitted) the function never discounts.
  enabled?: boolean;
  // Percentage off the promotional toy, e.g. 50 for 50% off.
  discountPercentage?: number;
  // Minimum cart subtotal required, keyed by ISO currency code (AUD, USD, ...).
  thresholds?: Record<string, number>;
  // The promotional toy product. Any variant of this product in the cart is
  // discounted. This is the most robust match because toys can have variants.
  productId?: string;
  // Optional explicit variant allow-list. Used in addition to productId so the
  // promo still works if only a variant gid is known.
  variantIds?: string[];
  // Discount label shown in checkout/order summaries.
  message?: string;
}

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  const noOps: CartLinesDiscountsGenerateRunResult = {operations: []};

  if (!input.cart.lines.length) {
    return noOps;
  }

  // This is a product-class discount (percentage off a specific toy line).
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return noOps;
  }

  const subtotal = input.cart.cost?.subtotalAmount;
  const currencyCode = subtotal?.currencyCode;
  if (!currencyCode) {
    return noOps;
  }

  const configValue = input.discount?.metafield?.value;
  const config: FunctionConfig = configValue ? JSON.parse(configValue) : {};

  if (config.enabled === false) {
    return noOps;
  }

  const percentage = config.discountPercentage;
  if (typeof percentage !== 'number' || percentage <= 0 || percentage > 100) {
    return noOps;
  }

  // Per-currency spend gate. If we have no threshold for this currency we
  // deliberately do nothing rather than guess a default.
  const threshold = config.thresholds?.[currencyCode];
  if (typeof threshold !== 'number' || threshold <= 0) {
    return noOps;
  }

  // Decision: the qualifying spend INCLUDES the toy, so the cart subtotal is
  // compared directly against the threshold.
  const cartSubtotal = Number(subtotal.amount);
  if (!Number.isFinite(cartSubtotal) || cartSubtotal < threshold) {
    return noOps;
  }

  const productId = config.productId;
  const variantIds = new Set(
    Array.isArray(config.variantIds) ? config.variantIds : [],
  );
  if (!productId && variantIds.size === 0) {
    return noOps;
  }

  // Find every cart line that is the promotional toy.
  const targets = input.cart.lines
    .filter((line) => {
      const merchandise = line.merchandise;
      if (!('id' in merchandise)) {
        return false;
      }
      if (variantIds.has(merchandise.id)) {
        return true;
      }
      return Boolean(
        productId &&
          'product' in merchandise &&
          merchandise.product?.id === productId,
      );
    })
    .map((line) => ({cartLine: {id: line.id}}));

  if (!targets.length) {
    return noOps;
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: config.message || `${percentage}% off`,
              targets,
              value: {
                percentage: {value: percentage},
              },
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
