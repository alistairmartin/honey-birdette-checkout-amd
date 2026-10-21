import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  useDiscountCodes,
  useAppliedGiftCards,
  useBuyerJourneyIntercept,
  useCartLines,
  useEmail,
} from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<App />, document.body);
}

// Staff gift card endings that block checkout if combined with a discount code.
// Format is HB + last digit of the year + quarter, e.g. 2027 Q1 = HB71, 2028 Q3 = HB83.
// Covers 2025 Q1 (HB51) to 2029 Q4 (HB94).
const BLOCKED_ENDS = [5, 6, 7, 8, 9].flatMap((year) =>
  [1, 2, 3, 4].map((quarter) => `hb${year}${quarter}`),
);

// Returns { block, titles } when the buyer (by email, so guests are covered) is
// tagged "Honey Birdette Staff" and the cart has "stop-staff-discount-code" products.
const STAFF_CHECK_URL = "https://honey-birdette-checkout-amd.onrender.com/api/checkout/staff-check";

const GIFT_CARD_MESSAGE =
  "Sorry Honey, you can't use discount codes with staff Gift Cards. Please remove either the discount code or the gift card.";
const STAFF_MESSAGE =
  "Sorry Honey, you can't use your staff discount with certain items in your cart. Please remove the discount code to continue.";

function App() {
  const discountCodes = useDiscountCodes();
  const appliedGiftCards = useAppliedGiftCards();
  const cartLines = useCartLines();

  let email: string | undefined;
  try {
    email = useEmail();
  } catch (_e) {
    email = undefined;
  }

  const discountApplied = discountCodes.length > 0;

  const giftCardBlocked = appliedGiftCards.some((card) =>
    BLOCKED_ENDS.includes(card.lastCharacters?.trim().toLowerCase() ?? ""),
  );

  // Stable key so the backend is only re-asked when the product set changes
  const productIdsKey = useMemo(
    () =>
      [...new Set(cartLines.map((line) => line.merchandise?.product?.id).filter(Boolean))]
        .sort()
        .join(","),
    [cartLines],
  );

  const [staffCheck, setStaffCheck] = useState<{ key: string; block: boolean; titles: string[] } | null>(null);

  useEffect(() => {
    const normalizedEmail = (email || "").trim().toLowerCase();
    // Only worth a round trip when there's a code to block
    if (!discountApplied || !normalizedEmail.includes("@") || !productIdsKey) return;

    const key = `${normalizedEmail}|${productIdsKey}`;
    if (staffCheck?.key === key) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const token = await shopify.sessionToken.get();
        const res = await fetch(STAFF_CHECK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ email: normalizedEmail, product_ids: productIdsKey.split(",") }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setStaffCheck({ key, block: Boolean(data?.block), titles: data?.titles ?? [] });
      } catch (_err) {
        // Fail open: don't block checkout if the backend is unreachable
        if (!cancelled) setStaffCheck({ key, block: false, titles: [] });
      }
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [email, productIdsKey, discountApplied, staffCheck?.key]);

  const staffBlocked = discountApplied && Boolean(staffCheck?.block);

  let block: { heading: string; message: string } | null = null;
  if (discountApplied && giftCardBlocked) {
    block = { heading: "Cannot Use Staff Gift Cards with Discount Codes", message: GIFT_CARD_MESSAGE };
  } else if (staffBlocked) {
    const titles = staffCheck?.titles ?? [];
    block = {
      heading: "Staff Discount Not Available",
      message: titles.length ? `${STAFF_MESSAGE} (${titles.join(", ")})` : STAFF_MESSAGE,
    };
  }

  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    if (!block || !canBlockProgress) {
      return { behavior: "allow" };
    }
    return {
      behavior: "block",
      reason: block.heading,
      errors: [{ message: block.message }],
    };
  });

  return block ? (
    <s-banner heading={block.heading} tone="critical">
      <s-paragraph>{block.message}</s-paragraph>
    </s-banner>
  ) : null;
}
