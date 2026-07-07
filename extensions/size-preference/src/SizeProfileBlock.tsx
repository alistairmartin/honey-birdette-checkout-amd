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
  hosiery: ["S", "M", "L"],
  robe: ["S/M", "M/L"],
  latex: ["S/M", "M/L"],
};

const KEYS = Object.keys(OPTIONS);
const EMPTY_SIZES = KEYS.reduce((acc, k) => ({ ...acc, [k]: null }), {});

// band + cup render under Bra headings; everything else uses its own locale key.
const LABEL_KEY = { band: "braBand", cup: "braCup" };

const DEFAULT_API_URL = "https://honey-birdette-checkout-amd.onrender.com";

function t(key) {
  return shopify.i18n.translate(key);
}

function apiBase() {
  const raw = shopify.settings?.value?.api_url || DEFAULT_API_URL;
  return String(raw).replace(/\/+$/, "");
}

// Human-readable summary, e.g. "BRA 10D · THONG M · DRESS 12". Bra is band+cup
// combined; every other set category is shown as "KEY value".
function summarize(s) {
  const parts = [];
  if (s.band && s.cup) parts.push(`BRA ${s.band}${s.cup}`);
  for (const key of KEYS) {
    if (key === "band" || key === "cup") continue;
    if (s[key]) parts.push(`${key.toUpperCase()} ${s[key]}`);
  }
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

  // `savedSizes` = what's persisted; `draft` = the working selection.
  const [savedSizes, setSavedSizes] = useState(EMPTY_SIZES);
  const [draft, setDraft] = useState(EMPTY_SIZES);

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
          setDraft(incoming);
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

  // Tap a chip: select it, or deselect if it's already the current value.
  function pick(key, value) {
    setSaved(false);
    setSaveError(false);
    setDraft((prev) => ({ ...prev, [key]: prev[key] === value ? null : value }));
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
        body: JSON.stringify({ sizes: draft }),
      });
      if (!resp.ok) throw new Error(`POST failed: ${resp.status}`);
      const data = await resp.json();
      if (data?.userErrors?.length) throw new Error("userErrors");
      const persisted = normalize(data);
      setSavedSizes(persisted);
      setDraft(persisted);
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
  const dirty = !sameSizes(draft, savedSizes);

  return (
    <s-box border="base" padding="base" borderRadius="base">
      <s-stack gap="loose">
        <s-stack gap="small-300">
          <s-heading>{t("title")}</s-heading>
          <s-text color="subdued">{summary || t("subtitle")}</s-text>
        </s-stack>

        {loadError && (
          <s-banner tone="critical">
            <s-text>{t("loadError")}</s-text>
          </s-banner>
        )}

        {KEYS.map((key) => (
          <>
            <ChipGroup
              key={key}
              label={t(LABEL_KEY[key] || key)}
              options={OPTIONS[key]}
              value={draft[key]}
              onPick={(v) => pick(key, v)}
            />
            {key === "cup" && <s-text color="subdued">{t("braHint")}</s-text>}
          </>
        ))}

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

function ChipGroup({ label, options, value, onPick }) {
  return (
    <s-stack gap="small-300">
      <s-text color="subdued" type="strong">{label}</s-text>
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(56px, 1fr))" gap="small-500">
        {options.map((opt) => (
          <s-button
            key={opt}
            inlineSize="fill"
            variant={value === opt ? "primary" : "secondary"}
            onClick={() => onPick(opt)}
          >
            {opt}
          </s-button>
        ))}
      </s-grid>
    </s-stack>
  );
}
