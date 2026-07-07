# Handoff: Customer Size Preference (Shopify)

## Overview
A "size profile" feature for the Honey Birdette storefront. Customers save their sizes once — bra band + cup, thong, brief, and dress — then:

1. **Account pages** show a slim "My size profile" bar that opens a modal to set/update sizes (stored on a customer metafield).
2. **Collection pages** get a "SHOP IN MY SIZE" toggle. When ON, product-card quick add becomes one tap — the saved size for that product type is added to cart directly, with a toast confirmation.
3. **Product pages** (and anywhere with add-to-cart) pre-select the saved size. The variant selector is hidden behind a "Change size" link when a saved size is applied.
4. **Logged-out visitors** can still save sizes to the device (localStorage), with persistent prompts to sign in so sizes sync to their account.

## About the Design Files
The file in this bundle (`Sizing Preference Extension.dc.html`) is a **design reference created in HTML** — a working prototype showing intended look and behavior, not production code to copy. The task is to **recreate this design in the real stack**:

- **Shopify Customer Account Extension** (or account page section) for the size profile bar + modal
- **Theme (Liquid/JS or Hydrogen/React)** for the collection toggle, quick add, and PDP behavior
- **Customer metafield** as the source of truth: suggested `customer.metafields.custom.size_profile` (JSON type)

A dark "PROTOTYPE" bar at the top of the HTML file is demo chrome only (screen switcher + fake sign in/out) — do not implement it.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and interactions follow the Honey Birdette design system (Futura PT, black/beige palette, sharp corners). Recreate pixel-perfectly using the existing theme's tokens and components where they exist.

## Data Model

Metafield `customer.metafields.custom.size_profile` — JSON:

```json
{ "band": "10", "cup": "D", "thong": "M", "brief": "M", "dress": "12" }
```

- All keys nullable. Bra preference is valid only when BOTH band and cup are set.
- Size ranges (AU): band `8–16` (step 2), cup `A B C D DD E F G`, thong/brief `XS S M L XL XXL`, dress `6–16` (step 2).
- Guest fallback: same JSON in `localStorage` (prototype key `hb_sizepref_proto_v1`). On login/signup, merge local → metafield and show a "sizes saved to your account" toast.
- Preferred size resolution by product type:
  - bra → `band + cup` (e.g. `10D`)
  - thong → `thong`; brief → `brief`; dress → `dress`
  - Product type should come from a product tag/metafield or Shopify product type.

## Screens / Views

### 1. Account page — Size Profile Bar (renders on EVERY account page)
- White bar on the beige account background: `background #FFFFFF; border 1px solid rgba(0,0,0,0.08); padding 18px 22px; display flex; align-items center; gap 18px`. No radius, no shadow.
- Left: Phosphor `ph-ruler` icon 20px black.
- Text column (gap 5px):
  - `MY SIZE PROFILE` — 11px, uppercase, letter-spacing 0.1em, weight 500, #111.
  - Summary line — 10px, uppercase, letter-spacing 0.08em, weight 500, #888, single line with ellipsis. Content: `BRA 10D · THONG M · BRIEF M · DRESS 12` (only set values), or empty state `NO SIZES SAVED YET — SET THEM ONCE, SHOP FASTER EVERYWHERE`.
- Right (margin-left auto): solid black button, white text, `padding 13px 24px; font 11px uppercase; letter-spacing 0.075rem; weight 500`. Label: `UPDATE SIZES` (has sizes) / `SET MY SIZES` (empty). Opens the Size Profile Modal.
- Hover on all solid black buttons: opacity 0.85, 220ms `cubic-bezier(0.22,0.61,0.36,1)`.

### 2. Size Profile Modal (openable from any page)
- Overlay `rgba(0,0,0,0.32)`, fade-in 220ms. Panel: white, 560px wide, `padding 36px 40px 40px`, sharp corners, shadow `0 12px 32px rgba(0,0,0,0.14)`, slide-up + fade 420ms.
- Header: script display font (Tangier / Pinyon Script fallback), italic 30px, `Your size, Betta`; sub-line 12px #555 `Set it once — we'll pick it everywhere you add to bag.`; `ph-x` close icon top right.
- Guest notice (logged out only): beige `#F1ECE4` strip, 12px padding, 10px uppercase label `SAVED ON THIS DEVICE` with `ph-device-mobile` icon and right-aligned underlined link `SIGN IN TO SAVE TO ACCOUNT`.
- Five chip groups, each preceded by a 10px uppercase #888 label: `BRA — BAND`, `BRA — CUP`, `THONG`, `BRIEF`, `DRESS`.
- Chips: min-width 46px, height 42px (44px on account/PDP variants — keep ≥44px hit target on mobile), 12px text, weight 500.
  - Unselected: white bg, #111 text, border `1px solid rgba(0,0,0,0.18)`.
  - Selected: black bg, white text, black border.
  - Tapping a selected chip deselects it (allows clearing a category).
- Full-width black `SAVE MY SIZES` button (17px padding). On save: persist metafield (or localStorage for guests), close, toast `SIZE PROFILE SAVED TO YOUR ACCOUNT` / `SIZES SAVED TO THIS DEVICE`.

### 3. Collection page — toggle + quick add
- Toolbar right of the collection H1: bordered button `SHOP IN MY SIZE` with `ph-ruler` icon and a square mini-switch (34×18 track, 12×12 knob, knob slides left 2px→18px, 220ms). OFF: white bg / black text / black 1px border. ON: inverted — black bg / white text.
- When ON, a line under the button: size summary (`BRA 10D · THONG M …`) + underlined `EDIT` link → opens Size Profile Modal.
- Product card quick-add bar: absolutely positioned inside the image, `left/right/bottom 12px`, `padding 13px`, 11px uppercase, weight 500, letter-spacing 0.075rem, with a leading icon:
  - Toggle ON + preference exists for this product type → **black bar, white text**: `⚡ QUICK ADD — 10D` (`ph-lightning`). Tap = add that variant to cart immediately + toast. No size picker.
  - Toggle ON, no preference for this type → black bar `SET YOUR BRA SIZE` (`ph-ruler`) → opens Size Profile Modal.
  - Toggle OFF → **white bar `rgba(255,255,255,0.92)`, black text**: `+ SELECT SIZE` (`ph-plus`) → navigates to the product page.
- Toggle tap logic:
  - ON → OFF: just turn off.
  - OFF → ON with saved sizes: turn on.
  - OFF → ON, logged in, no sizes: open Size Profile Modal; enable toggle after successful save.
  - OFF → ON, logged out, no sizes: open Sign In Modal (see below); after sign-in or "continue as guest" → Size Profile Modal → save → toggle enables.

### 4. Product page
- If a saved size exists for the product's type, pre-select that variant on load and show a beige `#F1ECE4` info bar (12px padding, 10px uppercase): `✓ YOUR SIZE — 10D` (`ph-check-circle`) with two underlined links right-aligned: `CHANGE SIZE` (expands the inline variant selector; label flips to `HIDE SIZES`) and `EDIT PROFILE` (#888, opens Size Profile Modal).
- **Variant selector hidden by default when a saved size is applied**; shown when no preference exists or after `CHANGE SIZE`.
- Bras show two chip rows (BAND, CUP); other types one row (SIZE). Chip style identical to the modal, 44px height.
- Add to cart: full-width black button, label includes selection + price: `ADD TO BAG — 10D · $89.95`; disabled at 0.35 opacity with `SELECT A SIZE` when nothing selected.
- Adding fires the same toast as quick add.

### 5. Sign In Modal (logged-out entry point)
- Same overlay/panel treatment, 420px wide, `padding 40px`.
- `SIGN IN` heading (16px uppercase), body copy: `Sign in to save your size profile to your account — it follows you on every device.`
- Email + password inputs: 1px `rgba(0,0,0,0.18)` border, radius 0, 14px padding, uppercase placeholder.
- Full-width black `SIGN IN & SAVE` button.
- Below: underlined text button `CONTINUE AS GUEST — SAVE SIZES TO THIS DEVICE` → closes and opens the Size Profile Modal in guest mode.
- After sign-in: if local sizes existed, write them to the metafield and toast `SIGNED IN — SIZES SAVED TO YOUR ACCOUNT`; if none, open the Size Profile Modal.

### 6. Toast (confirmation)
- Fixed bottom-center, 28px from bottom. Black bg, white text, 11px uppercase, letter-spacing 0.1em, `padding 15px 24px`, leading Phosphor icon, shadow `0 12px 32px rgba(0,0,0,0.14)`.
- Slide-up + fade in 220ms; auto-dismiss after ~2.6s.
- Messages: `ADDED — EVA BRA · 10D` (`ph-handbag-simple`), `SIZE PROFILE SAVED TO YOUR ACCOUNT` (`ph-check-circle`), `SIGNED IN — SIZES SAVED TO YOUR ACCOUNT` (`ph-user-check`).

## Interactions & Behavior
- All transitions: 220ms default, 420ms for modals/drawers, easing `cubic-bezier(0.22, 0.61, 0.36, 1)`.
- Quick add with preference must NOT open any picker — instant add + toast is the core value of the feature.
- Cart line items show `Color · Size` (e.g. `Black · 10D`).
- Deselecting sizes: a category with no value simply falls back to the normal selector for those products; toggle stays on for other types.
- Sizes persist across sessions (metafield for customers, localStorage for guests).

## State Management
- `sizeProfile` (metafield/localStorage JSON above)
- `shopInMySize` toggle (persist per device — localStorage; per-customer persistence optional)
- `isLoggedIn` (Shopify customer)
- Modal open states: size profile modal, sign-in modal
- `pendingToggle` — remembers the user tried to enable the toggle before having sizes, so it auto-enables after save
- PDP: selected variant + `selectorOpen` (false when preference applied)
- Cart + toast (existing theme systems)

## Design Tokens (Honey Birdette DS)
- Colors: black `#000000`, ink `#111111`, secondary `#333333`, muted `#555555`, faint `#888888`, borders `rgba(0,0,0,0.08)` / `rgba(0,0,0,0.18)`, overlay `rgba(0,0,0,0.32)`, white `#FFFFFF`, beige `#F1ECE4` (notices) / `#F4F2EC` (account bg), sale red `#EA2121`.
- Type: Futura PT — 500 for UI/uppercase labels, 400 for body. Script accent (Tangier / Pinyon Script) only for the modal greeting. UI sizes 10–13px with 0.075–0.15rem tracking; body 14–16px.
- Radius: 0 everywhere. Shadows only on modals/toast (`0 12px 32px rgba(0,0,0,0.14)`).
- Spacing: 4px scale (8, 12, 16, 18, 22, 24, 32, 40…).
- Icons: Phosphor (regular weight) — `ph-ruler`, `ph-lightning`, `ph-plus`, `ph-check-circle`, `ph-x`, `ph-handbag-simple`, `ph-device-mobile`, `ph-warning-circle`, `ph-user-check`.

## Assets
- No imagery shipped — product tiles use placeholder gradients. Use real product photography in production.
- Icons via `@phosphor-icons/web` CDN (or the theme's existing Phosphor setup).
- Fonts via the client's Typekit kit (`ynj0dtr`) / theme font stack.

## Files
- `Sizing Preference Extension.dc.html` — the full interactive prototype (open in a browser; the `_ds/` design-system folder from the design project is required for fonts/tokens, otherwise system fallbacks render). Template markup is inside `<x-dc>`; behavior in the `Component` class script.
