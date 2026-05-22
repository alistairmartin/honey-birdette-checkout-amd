import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';

interface BundleConfig {
  id?: string;
  name?: string;
  tags?: string[];
  discountAmounts?: Record<string, number>;
}

interface FunctionConfig {
  bundles?: BundleConfig[];
}

interface ResolvedBundle {
  name?: string;
  tags: string[];
  discountAmount: number;
}

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.cart.lines.length) {
    return {operations: []};
  }

  if (!input.discount.discountClasses.includes(DiscountClass.Order)) {
    return {operations: []};
  }

  const currencyCode = input.cart.cost?.subtotalAmount?.currencyCode;
  if (!currencyCode) {
    return {operations: []};
  }

  const configValue = input.discount?.metafield?.value;
  const config: FunctionConfig = configValue ? JSON.parse(configValue) : {};

  const bundles: ResolvedBundle[] = (config.bundles ?? [])
    .map<ResolvedBundle | null>((b) => {
      const tags = Array.isArray(b.tags) ? b.tags : [];
      const amount = b.discountAmounts?.[currencyCode];
      if (!tags.length || typeof amount !== 'number' || amount <= 0) {
        return null;
      }
      return {name: b.name, tags, discountAmount: amount};
    })
    .filter((b): b is ResolvedBundle => b !== null)
    .sort((a, b) => b.discountAmount - a.discountAmount);

  if (!bundles.length) {
    return {operations: []};
  }

  const lineAvail = new Map<string, number>();
  const lineTagSet = new Map<string, Set<string>>();

  for (const line of input.cart.lines) {
    lineAvail.set(line.id, line.quantity);
    const merchandise = line.merchandise;
    if ('product' in merchandise && merchandise.product) {
      const tags = new Set<string>();
      for (const ht of merchandise.product.hasTags ?? []) {
        if (ht.hasTag) tags.add(ht.tag);
      }
      lineTagSet.set(line.id, tags);
    } else {
      lineTagSet.set(line.id, new Set());
    }
  }

  let totalDiscount = 0;
  const messages: string[] = [];

  for (const bundle of bundles) {
    let bundleCount = 0;

    while (true) {
      const consumedThisRound = new Map<string, number>();
      let satisfied = true;

      for (const tag of bundle.tags) {
        let pickedLine: string | null = null;
        for (const line of input.cart.lines) {
          const remaining =
            (lineAvail.get(line.id) ?? 0) -
            (consumedThisRound.get(line.id) ?? 0);
          if (remaining <= 0) continue;
          if (!lineTagSet.get(line.id)?.has(tag)) continue;
          pickedLine = line.id;
          break;
        }
        if (!pickedLine) {
          satisfied = false;
          break;
        }
        consumedThisRound.set(
          pickedLine,
          (consumedThisRound.get(pickedLine) ?? 0) + 1,
        );
      }

      if (!satisfied) break;

      for (const [lid, qty] of consumedThisRound) {
        lineAvail.set(lid, (lineAvail.get(lid) ?? 0) - qty);
      }
      bundleCount++;
    }

    if (bundleCount <= 0) continue;
    totalDiscount += bundleCount * bundle.discountAmount;
    if (bundle.name) {
      messages.push(
        bundleCount > 1 ? `${bundle.name} ×${bundleCount}` : bundle.name,
      );
    }
  }

  if (totalDiscount <= 0) {
    return {operations: []};
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: messages.join(' + ') || 'Bundle discount',
              targets: [{orderSubtotal: {excludedCartLineIds: []}}],
              value: {fixedAmount: {amount: totalDiscount}},
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
