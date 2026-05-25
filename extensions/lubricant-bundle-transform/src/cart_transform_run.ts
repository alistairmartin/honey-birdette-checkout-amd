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
}

const NO_CHANGES: CartTransformRunResult = {operations: []};

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

      const audAmount = b.discountAmounts?.AUD ?? 0;
      return {
        name: b.name,
        parentVariantId: b.parentVariantId,
        slots,
        sortKey: audAmount,
      };
    })
    .filter((b): b is ResolvedBundle => b !== null)
    .sort((a, b) => b.sortKey - a.sortKey);

  if (!bundles.length) return NO_CHANGES;

  const lineAvail = new Map<string, number>();
  const lineProductId = new Map<string, string | null>();

  for (const line of input.cart.lines) {
    lineAvail.set(line.id, line.quantity);
    const merchandise = line.merchandise;
    if ("product" in merchandise && merchandise.product) {
      lineProductId.set(line.id, merchandise.product.id);
    } else {
      lineProductId.set(line.id, null);
    }
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

      operations.push({
        linesMerge: {
          cartLines,
          parentVariantId: bundle.parentVariantId,
          title: bundle.name,
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
