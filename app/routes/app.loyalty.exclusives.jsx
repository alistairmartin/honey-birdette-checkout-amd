// Loyalty exclusives: tier-gated gift-with-purchase offers. Same page, engine,
// checkout extension and discount function as /app/gift-with-purchase; that
// route switches into loyalty mode when served from this path (see
// isLoyaltyRequest / useIsLoyalty there). Offers saved here carry
// `kind: "loyalty"` and are listed only here, never on the GWP page.
export { loader, action, default } from "./app.gift-with-purchase";
