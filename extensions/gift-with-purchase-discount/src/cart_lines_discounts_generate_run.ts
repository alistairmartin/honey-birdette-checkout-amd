import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

// One Gift With Purchase offer, as written by the Gift With Purchase admin
// page (app/lib/gwpAppV1.shared.js -> buildFunctionConfigs).
interface OfferConfig {
  enabled?: boolean;
  // "min_spend" | "subscription" | "buy_x_get_y". Only min_spend is gated on
  // subtotal here; the other triggers are gated by the checkout extension, which
  // only adds the gift line when the offer qualifies.
  trigger_type?: string;
  // Percentage off the gift line. 100 = free gift; 50 = half price, etc.
  discount_percentage?: number;
  // Minimum cart subtotal per ISO currency code (AUD, NZD, USD, CAD, GBP, EUR, AED).
  thresholds?: Record<string, number>;
  // The gift product. Any variant of this product in the cart is discounted.
  productId?: string | null;
  // Optional explicit variant allow-list (used when only a variant gid is known).
  variantIds?: string[];
  // Discount label shown in checkout/order summaries.
  message?: string;
}

// The discount metafield holds { configs: [...] }. Tolerate a bare array or a
// single object too, so older/hand-edited values still parse.
function parseConfigs(raw: string | undefined): OfferConfig[] {
  if (!raw) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(payload)) return payload as OfferConfig[];
  if (payload && typeof payload === 'object') {
    const configs = (payload as {configs?: unknown}).configs;
    if (Array.isArray(configs)) return configs as OfferConfig[];
    return [payload as OfferConfig];
  }
  return [];
}

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  const noOps: CartLinesDiscountsGenerateRunResult = {operations: []};

  if (!input.cart.lines.length) {
    return noOps;
  }

  // This is a product-class discount (percentage off the gift line).
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return noOps;
  }

  const subtotal = input.cart.cost?.subtotalAmount;
  const currencyCode = subtotal?.currencyCode;
  if (!currencyCode) {
    return noOps;
  }
  const cartSubtotal = Number(subtotal.amount);

  const configs = parseConfigs(input.discount?.metafield?.value);
  if (!configs.length) {
    return noOps;
  }

  const candidates: Array<{
    message: string;
    targets: Array<{cartLine: {id: string}}>;
    value: {percentage: {value: number}};
  }> = [];

  for (const config of configs) {
    if (config.enabled === false) continue;

    const percentage = Number(config.discount_percentage ?? 100);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      continue;
    }

    // Min-spend offers gate on the per-currency subtotal threshold. If there is
    // no threshold for the buyer's currency, the offer doesn't run in that market.
    const trigger = String(config.trigger_type || 'min_spend');
    if (trigger === 'min_spend') {
      const threshold = config.thresholds?.[currencyCode];
      if (typeof threshold !== 'number' || threshold <= 0) continue;
      if (!Number.isFinite(cartSubtotal) || cartSubtotal < threshold) continue;
    }

    const productId = config.productId || undefined;
    const variantIds = new Set(
      Array.isArray(config.variantIds) ? config.variantIds : [],
    );
    if (!productId && variantIds.size === 0) continue;

    // Find every cart line that is this offer's gift.
    const targets = input.cart.lines
      .filter((line) => {
        const merchandise = line.merchandise;
        if (!('id' in merchandise)) return false;
        if (variantIds.has(merchandise.id)) return true;
        return Boolean(
          productId &&
            'product' in merchandise &&
            merchandise.product?.id === productId,
        );
      })
      .map((line) => ({cartLine: {id: line.id}}));

    if (!targets.length) continue;

    candidates.push({
      message: config.message || `${percentage}% off`,
      targets,
      value: {percentage: {value: percentage}},
    });
  }

  if (!candidates.length) {
    return noOps;
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
