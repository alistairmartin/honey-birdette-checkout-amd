// @ts-nocheck -- Preact customer-account extension: Polaris web components (s-*)
// plus the global `shopify` object (2026-07 API). No React / @shopify/ui-extensions-react.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// The target is bound in shopify.extension.toml
// (customer-account.profile.block.render -> this module).
export default async () => {
  render(<SizeProfileBlock />, document.body);
};

// Store-owned customer metafields (namespace `size_preference`) that the theme
// also reads. Keep these in sync with the backend route (app/routes/api.size-preference.jsx)
// and METAFIELDS.md. Insertion order here IS the render order of the chip rows.
// Adding a category = one line here + one label in locales/en.default.json.
const OPTIONS = {
  band: ["8", "10", "12", "14", "16"],
  cup: ["A", "B", "C", "D", "DD", "E", "F", "G"],
  thong: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  brief: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  suspender: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  corset: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  skirt: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  swimsuit: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  top: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  bodysuit: ["XXS", "XS", "S", "M", "L", "XL", "XXL"],
  hosiery: ["S", "M", "L"],
  robe: ["S/M", "M/L"],
  latex: ["S/M", "M/L"],
};

const KEYS = Object.keys(OPTIONS);
const EMPTY_SIZES = KEYS.reduce((acc, k) => ({ ...acc, [k]: null }), {});

// The form collects a short list of sizes; some fan out to several stored keys
// on save (Bottoms -> thong/brief/skirt, Corset -> bodysuit) so the metafield
// contract and the theme stay unchanged. `label` is a locale key; `ranges`
// picks which OPTIONS list the dropdown shows.
const FIELDS = [
  { key: "band", label: "braBand", ranges: "band" },
  { key: "cup", label: "braCup", ranges: "cup" },
  { key: "corset", label: "corset", ranges: "corset" },
  { key: "suspender", label: "suspender", ranges: "suspender" },
  { key: "bottoms", label: "bottoms", ranges: "brief" },
  { key: "hosiery", label: "hosiery", ranges: "hosiery" },
  { key: "robe", label: "robe", ranges: "robe" },
];

// Stored sizes -> form values. Bottoms reads whichever bottoms key was saved.
function toDraft(sizes) {
  return {
    band: sizes.band || null,
    cup: sizes.cup || null,
    corset: sizes.corset || null,
    suspender: sizes.suspender || null,
    bottoms: sizes.thong || sizes.brief || sizes.skirt || null,
    hosiery: sizes.hosiery || null,
    robe: sizes.robe || null,
  };
}

// Form values -> full stored shape. Keys no longer collected in the form
// (top, swimsuit, latex) keep any previously saved value.
function fromDraft(draft, existing) {
  return {
    ...existing,
    band: draft.band,
    cup: draft.cup,
    corset: draft.corset,
    suspender: draft.suspender,
    hosiery: draft.hosiery,
    robe: draft.robe,
    bodysuit: draft.corset,
    thong: draft.bottoms,
    brief: draft.bottoms,
    skirt: draft.bottoms,
  };
}

const DEFAULT_API_URL = "https://honey-birdette-checkout-amd.onrender.com";

function t(key) {
  return shopify.i18n.translate(key);
}

function apiBase() {
  const raw = shopify.settings?.value?.api_url || DEFAULT_API_URL;
  return String(raw).replace(/\/+$/, "");
}

// Human-readable summary matching the form vocabulary, e.g. "BRA 10D ·
// BOTTOMS M". One Bottoms entry covers the fanned-out thong/brief/skirt keys;
// bodysuit (fed by corset) isn't repeated.
function summarize(s) {
  const parts = [];
  if (s.band && s.cup) parts.push(`BRA ${s.band}${s.cup}`);
  if (s.corset) parts.push(`CORSET ${s.corset}`);
  if (s.suspender) parts.push(`SUSPENDER ${s.suspender}`);
  const bottoms = s.thong || s.brief || s.skirt;
  if (bottoms) parts.push(`BOTTOMS ${bottoms}`);
  if (s.hosiery) parts.push(`STOCKINGS ${s.hosiery}`);
  if (s.robe) parts.push(`ROBE & CHEMISE ${s.robe}`);
  return parts.join(" · ");
}

function sameSizes(a, b) {
  return KEYS.every((k) => (a[k] || null) === (b[k] || null));
}

// Coerce a backend payload into a full Sizes object (missing keys -> null).
function normalize(data) {
  const out = { ...EMPTY_SIZES };
  for (const key of KEYS) {
    const v = data?.sizes?.[key];
    out[key] = typeof v === "string" && v ? v : null;
  }
  return out;
}

function SizeProfileBlock() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);

  // `savedSizes` = the persisted full key set; `draft` = the working form
  // selection (short FIELDS shape).
  const [savedSizes, setSavedSizes] = useState(EMPTY_SIZES);
  const [draft, setDraft] = useState(toDraft(EMPTY_SIZES));

  // Load the current profile from the backend on mount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const token = await shopify.sessionToken.get();
        const resp = await fetch(`${apiBase()}/api/size-preference`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
        const incoming = normalize(await resp.json());
        if (!cancelled) {
          setSavedSizes(incoming);
          setDraft(toDraft(incoming));
        }
      } catch (e) {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Choose a size from the dropdown; the empty option clears it (-> null).
  function pick(key, value) {
    setSaved(false);
    setSaveError(false);
    setDraft((prev) => ({ ...prev, [key]: value || null }));
  }

  async function save() {
    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      const token = await shopify.sessionToken.get();
      const resp = await fetch(`${apiBase()}/api/size-preference`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sizes: fromDraft(draft, savedSizes) }),
      });
      if (!resp.ok) throw new Error(`POST failed: ${resp.status}`);
      const data = await resp.json();
      if (data?.userErrors?.length) throw new Error("userErrors");
      const persisted = normalize(data);
      setSavedSizes(persisted);
      setDraft(toDraft(persisted));
      setSaved(true);
    } catch (e) {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <s-box border="base" padding="base" borderRadius="base">
        <s-stack gap="base">
          <s-heading>{t("title")}</s-heading>
          <s-skeleton-paragraph />
          <s-skeleton-paragraph />
        </s-stack>
      </s-box>
    );
  }

  const summary = summarize(savedSizes);
  const dirty = !sameSizes(fromDraft(draft, savedSizes), savedSizes);

  return (
    <s-box border="base" padding="base" borderRadius="base">
      {/* large-300 between sections/groups; each group uses base internally so
          its heading stays close to its own selects (valid tokens: none,
          small-500..small-100, base, large-100..large-500 - NOT "loose"). */}
      <s-stack gap="large-300">
        <s-stack gap="small-300">
          <s-heading>{t("title")}</s-heading>
          <s-text color="subdued">{summary || t("subtitle")}</s-text>
        </s-stack>

        {loadError && (
          <s-banner tone="critical">
            <s-text>{t("loadError")}</s-text>
          </s-banner>
        )}

        {/* Two-column pairing mirrors the storefront modal: band/cup,
            corset/suspender, bottoms/stockings, robe on its own row. */}
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          {FIELDS.map((field) => (
            <SizeSelect
              key={field.key}
              label={t(field.label)}
              options={OPTIONS[field.ranges]}
              value={draft[field.key]}
              onPick={(v) => pick(field.key, v)}
            />
          ))}
        </s-grid>

        {saveError && (
          <s-banner tone="critical">
            <s-text>{t("saveError")}</s-text>
          </s-banner>
        )}
        {saved && !dirty && (
          <s-banner tone="success">
            <s-text>{t("saved")}</s-text>
          </s-banner>
        )}

        <s-button
          variant="primary"
          inlineSize="fill"
          loading={saving}
          disabled={saving || !dirty}
          onClick={save}
        >
          {saving ? t("saving") : t("save")}
        </s-button>
      </s-stack>
    </s-box>
  );
}

// One dropdown per size category. The leading empty option lets the customer
// clear a size (submits as "" -> stored as null). The select renders its own
// label, so no separate label text is needed.
function SizeSelect({ label, options, value, onPick }) {
  return (
    <s-select
      label={label}
      value={value || ""}
      onChange={(event) => onPick(event.currentTarget.value)}
    >
      <s-option value="">{t("unset")}</s-option>
      {options.map((opt) => (
        <s-option key={opt} value={opt}>
          {opt}
        </s-option>
      ))}
    </s-select>
  );
}
