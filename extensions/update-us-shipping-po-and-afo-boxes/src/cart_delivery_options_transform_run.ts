import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
} from "../generated/api";


const PO_BOX_PATTERNS = ["po box", "p.o. box", "p.o box", "p o box"];
const MILITARY_CODES = ["afo", "apo", "pfo", "fpo"];

function isMilitaryOrPoBox(address1: string, city: string, zip: string): boolean {
  const a1 = address1.toLowerCase();
  const c = city.toLowerCase();
  const z = zip.toLowerCase();

  return (
    PO_BOX_PATTERNS.some((p) => a1.includes(p)) ||
    MILITARY_CODES.some((code) => z.includes(code) || c.includes(code))
  );
}

export function cartDeliveryOptionsTransformRun(input: CartDeliveryOptionsTransformRunInput): CartDeliveryOptionsTransformRunResult {
  const operations: CartDeliveryOptionsTransformRunResult["operations"] = [];

  for (const group of input.cart.deliveryGroups) {
    const addr = group.deliveryAddress;
    const address1 = addr?.address1 ?? "";
    const city = addr?.city ?? "";
    const zip = addr?.zip ?? "";

    const militaryOrPo = isMilitaryOrPoBox(address1, city, zip);

    for (const option of group.deliveryOptions) {
      const isPoPlan = option.title?.includes("PO/AFO/FPO") ?? false;

      if (militaryOrPo ? !isPoPlan : isPoPlan) {
        operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
      }
    }
  }

  return { operations };
};