import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

interface TierConfig {
  quantity?: number;
  // Bundle price per currency, e.g. {AUD: 70} for "2 for $70".
  prices?: Record<string, number>;
}

interface FunctionConfig {
  productIds?: string[];
  tiers?: TierConfig[];
  message?: string;
}

interface Unit {
  lineId: string;
  price: number;
}

const NO_DISCOUNT: CartLinesDiscountsGenerateRunResult = {operations: []};

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return NO_DISCOUNT;
  }

  let config: FunctionConfig;
  try {
    config = JSON.parse(input.discount?.metafield?.value ?? '{}');
  } catch {
    return NO_DISCOUNT;
  }

  const productIds = new Set(config.productIds ?? []);
  if (!productIds.size) return NO_DISCOUNT;

  // One unit per item so mixed products (e.g. Red + Ivory) pool together.
  const units: Unit[] = [];
  let currencyCode: string | null = null;
  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (!('product' in merchandise) || !merchandise.product) continue;
    if (!productIds.has(merchandise.product.id)) continue;
    const price = Number(line.cost.amountPerQuantity.amount);
    currencyCode = line.cost.amountPerQuantity.currencyCode;
    for (let i = 0; i < line.quantity; i++) {
      units.push({lineId: line.id, price});
    }
  }
  if (!currencyCode || units.length < 2) return NO_DISCOUNT;

  const tiers = (config.tiers ?? [])
    .map((t) => ({
      quantity: Number(t.quantity),
      price: Number(t.prices?.[currencyCode as string]),
    }))
    .filter(
      (t) =>
        Number.isInteger(t.quantity) && t.quantity >= 2 && t.price > 0,
    )
    // Fill the biggest tier first: 8 items = one 6-pack + one 2-pack.
    .sort((a, b) => b.quantity - a.quantity);
  if (!tiers.length) return NO_DISCOUNT;

  // Most expensive units go into bundles first, so the customer gets the
  // biggest saving when prices differ (e.g. one item is marked down).
  units.sort((a, b) => b.price - a.price);

  let next = 0;
  let totalSaving = 0;
  const discountedQty = new Map<string, number>();

  for (const tier of tiers) {
    while (units.length - next >= tier.quantity) {
      const group = units.slice(next, next + tier.quantity);
      const regular = group.reduce((sum, u) => sum + u.price, 0);
      const saving = regular - tier.price;
      if (saving <= 0) break;

      totalSaving += saving;
      for (const u of group) {
        discountedQty.set(u.lineId, (discountedQty.get(u.lineId) ?? 0) + 1);
      }
      next += tier.quantity;
    }
  }

  totalSaving = Math.round(totalSaving * 100) / 100;
  if (totalSaving <= 0) return NO_DISCOUNT;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: config.message?.trim() || 'Multibuy offer',
              targets: [...discountedQty].map(([id, quantity]) => ({
                cartLine: {id, quantity},
              })),
              value: {fixedAmount: {amount: totalSaving}},
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
