import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartDeliveryOptionsTransformRunResult = {
  operations: [],
};

// Marker that identifies the delivery options dedicated to PO/AFO/FPO boxes.
const PO_AFO_FPO = "PO/AFO/FPO";

// Substrings (lowercased) that indicate a military or PO box destination.
const ADDRESS1_MARKERS = ["po box", "p.o. box", "p.o box", "p o box"];
const ZIP_CITY_MARKERS = ["afo", "apo", "pfo", "fpo"];

function addressIsMilitaryOrPoBox(
  address: { address1?: string | null; city?: string | null; zip?: string | null } | null | undefined,
): boolean {
  if (!address) {
    return false;
  }

  const address1 = (address.address1 ?? "").toLowerCase();
  const city = (address.city ?? "").toLowerCase();
  const zip = (address.zip ?? "").toLowerCase();

  return (
    ADDRESS1_MARKERS.some((marker) => address1.includes(marker)) ||
    ZIP_CITY_MARKERS.some((marker) => zip.includes(marker)) ||
    ZIP_CITY_MARKERS.some((marker) => city.includes(marker))
  );
}

export function cartDeliveryOptionsTransformRun(
  input: CartDeliveryOptionsTransformRunInput,
): CartDeliveryOptionsTransformRunResult {
  const operations: CartDeliveryOptionsTransformRunResult["operations"] = [];

  for (const group of input.cart.deliveryGroups) {
    const isPoBoxOrMilitary = addressIsMilitaryOrPoBox(group.deliveryAddress);

    for (const option of group.deliveryOptions) {
      const isPoBoxOption = (option.title ?? "").includes(PO_AFO_FPO);

      // Mirrors the legacy Script's `delete_if`: for a military/PO box address
      // keep only the PO/AFO/FPO options; otherwise hide the PO/AFO/FPO options.
      const shouldHide = isPoBoxOrMilitary ? !isPoBoxOption : isPoBoxOption;

      if (shouldHide) {
        operations.push({
          deliveryOptionHide: {
            deliveryOptionHandle: option.handle,
          },
        });
      }
    }
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
