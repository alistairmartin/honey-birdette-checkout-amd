// Loyalty constants shared by the admin pages (client bundle) and the server.

// Honey Club tiers a loyalty exclusive can be limited to. `value` matches the
// custom.loyalty_tier metafield and tierForCustomerTags(); `tag` is the token in
// the customer tag cx-tier-<tag>-<region> (VIP is capitalised in the tags).
export const LOYALTY_TIERS = [
  { value: "Gold", tag: "gold", label: "Gold" },
  { value: "Diamond", tag: "diamond", label: "Diamond" },
  { value: "Platinum", tag: "platinum", label: "Platinum" },
  { value: "VIP", tag: "VIP", label: "VIP (Invite only)" },
];

// GWP configs saved from Loyalty > Exclusives carry kind "loyalty"; everything
// else is a regular Gift with purchase offer.
export function isLoyaltyConfig(config) {
  return config?.kind === "loyalty";
}

// Suggested redeemed tag for a new exclusive, from its title.
export function suggestRedeemedTag(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `redeemed-${slug}` : "";
}
