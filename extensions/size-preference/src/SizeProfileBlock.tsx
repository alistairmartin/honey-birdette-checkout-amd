import React, { useEffect, useMemo, useState } from "react";
import {
  reactExtension,
  Banner,
  BlockStack,
  Button,
  Divider,
  Heading,
  InlineStack,
  Pressable,
  SkeletonText,
  Text,
  View,
  useSessionToken,
  useSettings,
  useTranslate,
} from "@shopify/ui-extensions-react/customer-account";

export default reactExtension("customer-account.profile.block.render", () => (
  <SizeProfileBlock />
));

// Store-owned customer metafields (namespace `size_preference`) that the theme
// also reads. Keep these in sync with the backend route and METAFIELDS.md.
const OPTIONS = {
  band: ["8", "10", "12", "14", "16"],
  cup: ["A", "B", "C", "D", "DD", "E", "F", "G"],
  thong: ["XS", "S", "M", "L", "XL", "XXL"],
  brief: ["XS", "S", "M", "L", "XL", "XXL"],
  dress: ["6", "8", "10", "12", "14", "16"],
} as const;

type SizeKey = keyof typeof OPTIONS;
type Sizes = Record<SizeKey, string | null>;

const EMPTY_SIZES: Sizes = {
  band: null,
  cup: null,
  thong: null,
  brief: null,
  dress: null,
};

const DEFAULT_API_URL = "https://honey-birdette-checkout-amd.onrender.com";

// Human-readable summary of the saved sizes, e.g. "BRA 10D · THONG M · DRESS 12".
function summarize(s: Sizes): string {
  const parts: string[] = [];
  if (s.band && s.cup) parts.push(`BRA ${s.band}${s.cup}`);
  if (s.thong) parts.push(`THONG ${s.thong}`);
  if (s.brief) parts.push(`BRIEF ${s.brief}`);
  if (s.dress) parts.push(`DRESS ${s.dress}`);
  return parts.join(" · ");
}

function sameSizes(a: Sizes, b: Sizes): boolean {
  return (Object.keys(OPTIONS) as SizeKey[]).every((k) => (a[k] || null) === (b[k] || null));
}

function SizeProfileBlock() {
  const translate = useTranslate();
  const settings = useSettings();
  const sessionToken = useSessionToken();

  const apiUrl = useMemo(() => {
    const raw = (settings.api_url as string) || DEFAULT_API_URL;
    return raw.replace(/\/+$/, "");
  }, [settings.api_url]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);

  // `saved` sizes = what's persisted; `draft` = the working selection.
  const [savedSizes, setSavedSizes] = useState<Sizes>(EMPTY_SIZES);
  const [draft, setDraft] = useState<Sizes>(EMPTY_SIZES);

  // Load the current profile from the backend on mount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const token = await sessionToken.get();
        const resp = await fetch(`${apiUrl}/api/size-preference`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
        const data = await resp.json();
        const incoming: Sizes = { ...EMPTY_SIZES };
        for (const key of Object.keys(OPTIONS) as SizeKey[]) {
          const v = data?.sizes?.[key];
          incoming[key] = typeof v === "string" && v ? v : null;
        }
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
  }, [apiUrl, sessionToken]);

  // Tap a chip: select it, or deselect if it's already the current value.
  function pick(key: SizeKey, value: string) {
    setSaved(false);
    setSaveError(false);
    setDraft((prev) => ({ ...prev, [key]: prev[key] === value ? null : value }));
  }

  async function save() {
    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      const token = await sessionToken.get();
      const resp = await fetch(`${apiUrl}/api/size-preference`, {
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
      const persisted: Sizes = { ...EMPTY_SIZES };
      for (const key of Object.keys(OPTIONS) as SizeKey[]) {
        const v = data?.sizes?.[key];
        persisted[key] = typeof v === "string" && v ? v : null;
      }
      setSavedSizes(persisted);
      setDraft(persisted);
      setSaved(true);
    } catch (e) {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  const summary = summarize(savedSizes);
  const dirty = !sameSizes(draft, savedSizes);

  if (loading) {
    return (
      <View border="base" padding="base">
        <BlockStack spacing="base">
          <Heading level={3}>{translate("title")}</Heading>
          <SkeletonText />
          <SkeletonText />
        </BlockStack>
      </View>
    );
  }

  return (
    <View border="base" padding="base">
      <BlockStack spacing="loose">
        <BlockStack spacing="tight">
          <Heading level={3}>{translate("title")}</Heading>
          <Text size="small" appearance="subdued">
            {summary || translate("subtitle")}
          </Text>
        </BlockStack>

        {loadError && (
          <Banner status="critical">
            <Text>{translate("loadError")}</Text>
          </Banner>
        )}

        <Divider />

        <ChipGroup
          label={translate("braBand")}
          options={OPTIONS.band}
          value={draft.band}
          onPick={(v) => pick("band", v)}
        />
        <ChipGroup
          label={translate("braCup")}
          options={OPTIONS.cup}
          value={draft.cup}
          onPick={(v) => pick("cup", v)}
        />
        <Text size="small" appearance="subdued">
          {translate("braHint")}
        </Text>

        <ChipGroup
          label={translate("thong")}
          options={OPTIONS.thong}
          value={draft.thong}
          onPick={(v) => pick("thong", v)}
        />
        <ChipGroup
          label={translate("brief")}
          options={OPTIONS.brief}
          value={draft.brief}
          onPick={(v) => pick("brief", v)}
        />
        <ChipGroup
          label={translate("dress")}
          options={OPTIONS.dress}
          value={draft.dress}
          onPick={(v) => pick("dress", v)}
        />

        {saveError && (
          <Banner status="critical">
            <Text>{translate("saveError")}</Text>
          </Banner>
        )}
        {saved && !dirty && (
          <Banner status="success">
            <Text>{translate("saved")}</Text>
          </Banner>
        )}

        <Button
          kind="primary"
          onPress={save}
          loading={saving}
          disabled={saving || !dirty}
        >
          {saving ? translate("saving") : translate("save")}
        </Button>
      </BlockStack>
    </View>
  );
}

function ChipGroup({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly string[];
  value: string | null;
  onPick: (value: string) => void;
}) {
  return (
    <BlockStack spacing="tight">
      <Text size="small" emphasis="bold" appearance="subdued">
        {label}
      </Text>
      <InlineStack spacing="tight">
        {options.map((opt) => {
          const selected = value === opt;
          return (
            <Pressable
              key={opt}
              onPress={() => onPick(opt)}
              border="base"
              cornerRadius="none"
              background={selected ? "subdued" : "transparent"}
              padding={["tight", "base"]}
              accessibilityRole="button"
            >
              <Text emphasis={selected ? "bold" : undefined}>{opt}</Text>
            </Pressable>
          );
        })}
      </InlineStack>
    </BlockStack>
  );
}
