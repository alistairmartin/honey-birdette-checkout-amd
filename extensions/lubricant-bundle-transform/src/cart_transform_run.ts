import type {
  CartTransformRunInput,
  CartTransformRunResult,
  Operation,
} from "../generated/api";

interface BundleIndexEntry {
  id?: string;
  name?: string;
  parentVariantId?: string;
  productIds?: string[];
  option1Ids?: string[];
  option2Ids?: string[];
  discountAmounts?: Record<string, number>;
}

interface BundleIndex {
  bundles?: BundleIndexEntry[];
}

interface ResolvedBundle {
  name?: string;
  parentVariantId: string;
  slots: string[][];
  sortKey: number;
  discountAmounts: Record<string, number>;
}

const NO_CHANGES: CartTransformRunResult = {operations: []};

const CURRENCY_SYMBOL: Record<string, string> = {
  AUD: "$",
  USD: "$",
  NZD: "$",
  CAD: "$",
  GBP: "£",
  EUR: "€",
  AED: "د.إ ",
};

function formatMoney(amount: number, currencyCode: string | null): string {
  const safeAmount = amount.toFixed(2);
  if (!currencyCode) return safeAmount;
  const symbol = CURRENCY_SYMBOL[currencyCode];
  return symbol ? `${symbol}${safeAmount}` : `${currencyCode} ${safeAmount}`;
}

export function cartTransformRun(
  input: CartTransformRunInput,
): CartTransformRunResult {
  if (!input.cart.lines.length) return NO_CHANGES;

  const raw = input.cartTransform?.metafield?.value;
  if (!raw) return NO_CHANGES;

  let index: BundleIndex;
  try {
    index = JSON.parse(raw);
  } catch {
    return NO_CHANGES;
  }

  const bundles: ResolvedBundle[] = (index.bundles ?? [])
    .map<ResolvedBundle | null>((b) => {
      if (!b.parentVariantId) return null;
      const productIds = Array.isArray(b.productIds) ? b.productIds : [];
      if (!productIds.length) return null;

      const slots: string[][] = productIds.map((pid) => [pid]);
      if (Array.isArray(b.option1Ids) && b.option1Ids.length) {
        slots.push(b.option1Ids);
      }
      if (Array.isArray(b.option2Ids) && b.option2Ids.length) {
        slots.push(b.option2Ids);
      }

      const discountAmounts = b.discountAmounts ?? {};
      const audAmount = discountAmounts.AUD ?? 0;
      return {
        name: b.name,
        parentVariantId: b.parentVariantId,
        slots,
        sortKey: audAmount,
        discountAmounts,
      };
    })
    .filter((b): b is ResolvedBundle => b !== null)
    .sort((a, b) => b.sortKey - a.sortKey);

  if (!bundles.length) return NO_CHANGES;

  // Currency comes from any line's per-unit cost; all lines in a cart share
  // the same currency.
  const currencyCode =
    input.cart.lines[0]?.cost?.amountPerQuantity?.currencyCode ?? null;

  const lineAvail = new Map<string, number>();
  const lineProductId = new Map<string, string | null>();
  const linePerUnitCost = new Map<string, number>();

  for (const line of input.cart.lines) {
    lineAvail.set(line.id, line.quantity);
    const merchandise = line.merchandise;
    if ("product" in merchandise && merchandise.product) {
      lineProductId.set(line.id, merchandise.product.id);
    } else {
      lineProductId.set(line.id, null);
    }
    const perUnit = Number(line.cost?.amountPerQuantity?.amount ?? 0);
    linePerUnitCost.set(line.id, isFinite(perUnit) ? perUnit : 0);
  }

  const operations: Operation[] = [];

  for (const bundle of bundles) {
    while (true) {
      const consumedThisRound = new Map<string, number>();
      let satisfied = true;

      for (const slot of bundle.slots) {
        const slotSet = new Set(slot);
        let pickedLine: string | null = null;
        for (const line of input.cart.lines) {
          const remaining =
            (lineAvail.get(line.id) ?? 0) -
            (consumedThisRound.get(line.id) ?? 0);
          if (remaining <= 0) continue;
          const pid = lineProductId.get(line.id);
          if (!pid || !slotSet.has(pid)) continue;
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

      const cartLines = Array.from(consumedThisRound.entries()).map(
        ([cartLineId, quantity]) => ({cartLineId, quantity}),
      );

      // Sum the per-unit cost of the consumed children to determine the
      // pre-discount bundle total. We use amountPerQuantity (not the full
      // line subtotal) because a single cart line may have a higher quantity
      // than we're consuming for this bundle.
      let childrenSum = 0;
      for (const {cartLineId, quantity} of cartLines) {
        const perUnit = linePerUnitCost.get(cartLineId) ?? 0;
        childrenSum += perUnit * quantity;
      }

      const discountForCurrency = currencyCode
        ? Number(bundle.discountAmounts?.[currencyCode] ?? 0)
        : 0;

      let price: {percentageDecrease: {value: number}} | undefined;
      if (discountForCurrency > 0 && childrenSum > 0) {
        const rawPercent = (discountForCurrency / childrenSum) * 100;
        const capped = Math.min(100, Math.max(0, rawPercent));
        // 4 decimal places balances precision against MoneyV2 rounding noise.
        const percent = Math.round(capped * 10000) / 10000;
        price = {percentageDecrease: {value: percent}};
      }

      const attributes =
        childrenSum > 0
          ? [
              {
                key: "Original Price",
                value: formatMoney(childrenSum, currencyCode),
              },
            ]
          : [];

      operations.push({
        linesMerge: {
          cartLines,
          parentVariantId: bundle.parentVariantId,
          title: bundle.name,
          attributes,
          ...(price ? {price} : {}),
        },
      });

      for (const [lid, qty] of consumedThisRound) {
        lineAvail.set(lid, (lineAvail.get(lid) ?? 0) - qty);
      }
    }
  }

  if (!operations.length) return NO_CHANGES;
  return {operations};
}
