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
  // "min_spend" | "subscription" | "buy_x_get_y" | "buy_x_and_min_spend".
  // min_spend and buy_x_and_min_spend are gated on subtotal here; the other two
  // are gated by the checkout extension, which only adds the gift line when the
  // offer qualifies.
  trigger_type?: string;
  // Percentage off the gift line. 100 = free gift; 50 = half price, etc.
  discount_percentage?: number;
  // Minimum cart subtotal per ISO currency code (AUD, NZD, USD, CAD, GBP, EUR, AED).
  thresholds?: Record<string, number>;
  // buy_x_and_min_spend only: the products that satisfy the "buy X" half of the
  // trigger. The admin resolves the config's `product_tag` to Product gids on
  // every sync, because functions can't read product tags from the cart. An empty
  // or missing list fails the gate closed - see the trigger check below.
  qualifying_product_ids?: string[];
  // The gift product. Any variant of this product in the cart is discounted.
  // Kept for backward-compat with older configs; `productIds` is the full set.
  productId?: string | null;
  // All gift products this offer can hand out (the customer-picks-one set). Any
  // variant of any of these in the cart is discounted. Only one is ever present.
  productIds?: string[];
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

  // Gift cards must not count toward a min-spend threshold - a shopper shouldn't
  // unlock a free gift by buying a gift card. Subtract gift-card line subtotals
  // from the cart subtotal so this gate matches the checkout extension.
  const giftCardTotal = input.cart.lines.reduce((sum, line) => {
    const merchandise = line.merchandise;
    const isGiftCard =
      'product' in merchandise && Boolean(merchandise.product?.isGiftCard);
    if (!isGiftCard) return sum;
    const amount = Number(line.cost?.subtotalAmount?.amount || 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  const qualifyingSubtotal = Number.isFinite(cartSubtotal)
    ? cartSubtotal - giftCardTotal
    : cartSubtotal;

  const configs = parseConfigs(input.discount?.metafield?.value);
  if (!configs.length) {
    return noOps;
  }

  const candidates: Array<{
    message: string;
    targets: Array<{cartLine: {id: string; quantity?: number}}>;
    value: {percentage: {value: number}};
  }> = [];

  for (const config of configs) {
    if (config.enabled === false) continue;

    const percentage = Number(config.discount_percentage ?? 100);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      continue;
    }

    // Gift products this offer can hand out: the full `productIds` set, falling
    // back to the legacy single `productId` for older configs.
    const productIds = new Set(
      Array.isArray(config.productIds) && config.productIds.length
        ? config.productIds
        : config.productId
          ? [config.productId]
          : [],
    );
    const variantIds = new Set(
      Array.isArray(config.variantIds) ? config.variantIds : [],
    );
    if (productIds.size === 0 && variantIds.size === 0) continue;

    // Every cart line that is one of this offer's gifts.
    const giftLines = input.cart.lines.filter((line) => {
      const merchandise = line.merchandise;
      if (!('id' in merchandise)) return false;
      if (variantIds.has(merchandise.id)) return true;
      return Boolean(
        'product' in merchandise &&
          merchandise.product?.id &&
          productIds.has(merchandise.product.id),
      );
    });
    if (!giftLines.length) continue;

    const trigger = String(config.trigger_type || 'min_spend');

    // "Buy X" half of buy_x_and_min_spend: the cart must hold at least one
    // non-gift line whose product is in the resolved qualifying set. Functions
    // can't read product tags, so the admin resolves the config's `product_tag`
    // to Product gids on every sync. If that resolution produced nothing, the
    // gate can't be checked here - fail closed rather than give the gift away.
    if (trigger === 'buy_x_and_min_spend') {
      const qualifyingIds = new Set(
        Array.isArray(config.qualifying_product_ids)
          ? config.qualifying_product_ids
          : [],
      );
      if (qualifyingIds.size === 0) continue;
      const giftLineIds = new Set(giftLines.map((line) => line.id));
      const hasQualifyingLine = input.cart.lines.some((line) => {
        if (giftLineIds.has(line.id)) return false;
        const merchandise = line.merchandise;
        return Boolean(
          'product' in merchandise &&
            merchandise.product?.id &&
            qualifyingIds.has(merchandise.product.id),
        );
      });
      if (!hasQualifyingLine) continue;
    }

    // Spend-gated offers check the per-currency subtotal threshold. If there is
    // no threshold for the buyer's currency, the offer doesn't run in that market.
    if (trigger === 'min_spend' || trigger === 'buy_x_and_min_spend') {
      const threshold = config.thresholds?.[currencyCode];
      if (typeof threshold !== 'number' || threshold <= 0) continue;
      // The gift's own value must NOT help unlock its discount: the customer has
      // to spend the threshold on other products first. Subtract this offer's
      // gift lines from the qualifying subtotal (gift cards are already removed).
      const giftLinesTotal = giftLines.reduce((sum, line) => {
        const amt = Number(line.cost?.subtotalAmount?.amount || 0);
        return sum + (Number.isFinite(amt) ? amt : 0);
      }, 0);
      const eligibleSpend = qualifyingSubtotal - giftLinesTotal;
      if (!Number.isFinite(eligibleSpend) || eligibleSpend < threshold) continue;
    }

    // Discount only ONE unit of the gift, even if the customer added several
    // (or added more than one gift option). Pick the highest unit-price gift
    // line so they get the best value on the single discounted item.
    let bestLine = giftLines[0];
    let bestUnit = -Infinity;
    for (const line of giftLines) {
      const sub = Number(line.cost?.subtotalAmount?.amount || 0);
      const qty = Number(line.quantity || 1) || 1;
      const unit = sub / qty;
      if (Number.isFinite(unit) && unit > bestUnit) {
        bestUnit = unit;
        bestLine = line;
      }
    }

    candidates.push({
      message: config.message || `${percentage}% off`,
      targets: [{cartLine: {id: bestLine.id, quantity: 1}}],
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
