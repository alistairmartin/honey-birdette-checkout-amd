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

    const expandedCartItems = [
      ...bundle.fixedVariantIds.map((variantId) => ({
        merchandiseId: variantId,
        quantity: 1,
        price: {adjustment: {fixedPricePerUnit: {amount: "0.00"}}},
      })),
      ...(opt1VariantId
        ? [
            {
              merchandiseId: opt1VariantId,
              quantity: 1,
              price: {adjustment: {fixedPricePerUnit: {amount: "0.00"}}},
            },
          ]
        : []),
      ...(opt2VariantId
        ? [
            {
              merchandiseId: opt2VariantId,
              quantity: 1,
              price: {adjustment: {fixedPricePerUnit: {amount: "0.00"}}},
            },
          ]
        : []),
    ];

    if (!expandedCartItems.length) continue;

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
