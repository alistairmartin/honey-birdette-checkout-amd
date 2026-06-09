import '@shopify/ui-extensions/preact';
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";

// Shipping country that triggers the field.
const MEXICO = "MX";

// Where the captured RFC is persisted:
//  - an order attribute, for human visibility (admin "Additional details", Liquid, packing slips)
//  - an app-owned order metafield, for structured/programmatic use (Admin API, Flow, tax/invoicing)
const ATTRIBUTE_KEY = "Mexico RFC";
const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "mexicoTaxId";

// Light RFC format check: 12 chars (companies) or 13 (individuals), alphanumeric.
// Ñ and & are valid RFC characters. We deliberately avoid the full structural
// regex so we don't reject edge-case-valid RFCs.
const RFC_PATTERN = /^[A-ZÑ&0-9]{12,13}$/;

function normalize(value) {
  return (value || "").toUpperCase().replace(/\s+/g, "");
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const country = shopify.shippingAddress.value?.countryCode;
  const storedRfc =
    shopify.attributes.value.find((attribute) => attribute.key === ATTRIBUTE_KEY)
      ?.value ?? "";

  const [value, setValue] = useState(storedRfc);
  const [error, setError] = useState("");

  // Pre-fill once the cart attributes have loaded (they arrive asynchronously),
  // without clobbering anything the buyer has already typed.
  useEffect(() => {
    if (storedRfc && !value) setValue(storedRfc);
  }, [storedRfc]);

  // If the buyer switches away from Mexico, drop any RFC we previously stored so
  // it doesn't linger on a non-Mexican order.
  useEffect(() => {
    if (country !== MEXICO && storedRfc) clearStored();
  }, [country]);

  if (country !== MEXICO) return null;

  return (
    <s-stack gap="small-200">
      <s-text-field
        label={shopify.i18n.translate("rfcLabel")}
        name="mexico_rfc"
        autocomplete="off"
        maxLength={13}
        value={value}
        error={error}
        onInput={(event) => {
          const target = /** @type {HTMLInputElement} */ (event.currentTarget);
          setValue(target.value);
        }}
        onChange={commit}
        onBlur={commit}
      />
      <s-text color="subdued" type="small">
        {shopify.i18n.translate("rfcHelp")}
      </s-text>
    </s-stack>
  );

  async function commit() {
    const rfc = normalize(value);
    setValue(rfc);

    if (rfc === "") {
      setError("");
      await clearStored();
      return;
    }

    if (!RFC_PATTERN.test(rfc)) {
      setError(shopify.i18n.translate("rfcInvalid"));
      return;
    }

    setError("");
    await persist(rfc);
  }

  async function persist(rfc) {
    if (shopify.instructions.value.attributes.canUpdateAttributes) {
      await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: ATTRIBUTE_KEY,
        value: rfc,
      });
    }

    if (shopify.instructions.value.metafields.canSetCartMetafields) {
      await shopify.applyMetafieldChange({
        type: "updateCartMetafield",
        metafield: {
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          value: rfc,
          type: "single_line_text_field",
        },
      });
    }
  }

  async function clearStored() {
    if (shopify.instructions.value.attributes.canUpdateAttributes) {
      await shopify.applyAttributeChange({
        type: "removeAttribute",
        key: ATTRIBUTE_KEY,
      });
    }

    if (shopify.instructions.value.metafields.canSetCartMetafields) {
      await shopify.applyMetafieldChange({
        type: "removeCartMetafield",
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
      });
    }
  }
}
