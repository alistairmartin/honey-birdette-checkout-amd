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
  productVariantIds?: string[];
  option1Ids?: string[];
  option1VariantIds?: string[];
  option2Ids?: string[];
  option2VariantIds?: string[];
  discountAmounts?: Record<string, number>;
}

interface BundleIndex {
  bundles?: BundleIndexEntry[];
}

interface ResolvedBundle {
  name?: string;
  parentVariantId: string;
  fixedVariantIds: string[];
  option1VariantIds: string[];
  option2VariantIds: string[];
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

  // Resolve bundles, indexed by parentVariantId for quick lookup.
  const bundlesByParent = new Map<string, ResolvedBundle>();
  for (const b of index.bundles ?? []) {
    if (!b.parentVariantId) continue;
    const fixedVariantIds = Array.isArray(b.productVariantIds)
      ? b.productVariantIds
      : [];
    if (!fixedVariantIds.length) continue;

    bundlesByParent.set(b.parentVariantId, {
      name: b.name,
      parentVariantId: b.parentVariantId,
      fixedVariantIds,
      option1VariantIds: Array.isArray(b.option1VariantIds)
        ? b.option1VariantIds
        : [],
      option2VariantIds: Array.isArray(b.option2VariantIds)
        ? b.option2VariantIds
        : [],
    });
  }

  if (!bundlesByParent.size) return NO_CHANGES;

  const operations: Operation[] = [];

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (!("id" in merchandise) || !merchandise.id) continue;

    const bundle = bundlesByParent.get(merchandise.id);
    if (!bundle) continue;

    // Customer's chosen option variants are stored as line item properties.
    // If the chosen value isn't in the allowed list, fall back to the first
    // option to keep the bundle valid (defensive against tampering).
    const rawOpt1 = line.bundleOption1?.value ?? null;
    const rawOpt2 = line.bundleOption2?.value ?? null;

    const opt1VariantId =
      rawOpt1 && bundle.option1VariantIds.includes(rawOpt1)
        ? rawOpt1
        : bundle.option1VariantIds[0] ?? null;
    const opt2VariantId =
      rawOpt2 && bundle.option2VariantIds.includes(rawOpt2)
        ? rawOpt2
        : bundle.option2VariantIds[0] ?? null;

    // Build the list of child variant IDs to expand into.
    const childVariantIds: string[] = [
      ...bundle.fixedVariantIds,
      ...(opt1VariantId ? [opt1VariantId] : []),
      ...(opt2VariantId ? [opt2VariantId] : []),
    ];

    if (!childVariantIds.length) continue;

    // lineExpand sets the parent cart line's cost to the sum of the
    // expanded children's costs. Distribute the parent variant's actual
    // per-unit price evenly across the children so the line total matches
    // what the customer was shown on the PDP. Last child absorbs any
    // rounding remainder so the sum is exact to the cent.
    const parentAmount = Number(line.cost?.amountPerQuantity?.amount ?? 0);
    const numChildren = childVariantIds.length;
    const evenShareCents = Math.floor((parentAmount * 100) / numChildren);
    const evenShare = (evenShareCents / 100).toFixed(2);
    const remainderCents =
      Math.round(parentAmount * 100) - evenShareCents * numChildren;
    const lastShare = ((evenShareCents + remainderCents) / 100).toFixed(2);

    const expandedCartItems = childVariantIds.map((variantId, index) => ({
      merchandiseId: variantId,
      quantity: 1,
      price: {
        adjustment: {
          fixedPricePerUnit: {
            amount: index === numChildren - 1 ? lastShare : evenShare,
          },
        },
      },
    }));

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems,
        title: bundle.name,
      },
    });
  }

  if (!operations.length) return NO_CHANGES;
  return {operations};
}
