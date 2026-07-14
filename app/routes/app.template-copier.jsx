// Template copier - copy theme templates from the store you're on into the same
// or a different theme on any of the other stores this app is installed on.
//
// The page is deliberately read-heavy before it writes anything: it lists the
// source theme's templates, then (on confirm) reports which sections the
// destination theme is missing, so you find out a template won't render *before*
// you overwrite it rather than after. Writes go through themeFilesUpsert, which
// Shopify records in the destination theme's version history - a bad copy can be
// rolled back from the theme editor's timeline.
//
// See app/lib/themeCopier.server.js for the API side.

import { json } from "@remix-run/node";
import { useEffect, useMemo, useState } from "react";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Autocomplete,
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Modal,
  Page,
  ProgressBar,
  Scrollable,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  copyToTarget,
  getShopInfo,
  listDestinationShops,
  listTemplateFiles,
  listThemes,
  listThemesForShop,
  readFiles,
  recentCopies,
  revertCopy,
  reviewTarget,
} from "../lib/themeCopier.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const sourceShop = session.shop;

  const themes = await listThemes(admin);
  // Themes come back most-recently-edited first, so the default source theme is
  // the one that was touched last - nearly always the one you just finished
  // editing and now want to push to the other regions.
  const initialTheme = themes[0] ?? null;

  const [source, templates, shops, history] = await Promise.all([
    getShopInfo(admin, sourceShop).catch(() => ({
      shop: sourceShop,
      name: sourceShop,
      flag: "",
    })),
    initialTheme ? listTemplateFiles(admin, initialTheme.id) : [],
    listDestinationShops(sourceShop),
    recentCopies(sourceShop),
  ]);

  // Destination themes are loaded up front (one call per store) so switching
  // between stores in the picker is instant.
  const destinations = await Promise.all(
    shops.map(async (shop) => {
      if (!shop.reachable) return { ...shop, themes: [] };
      try {
        return { ...shop, themes: await listThemesForShop(shop.shop) };
      } catch (err) {
        return {
          ...shop,
          themes: [],
          reachable: false,
          error: err?.message ?? String(err),
        };
      }
    }),
  );

  return json({
    source,
    themes,
    initialThemeId: initialTheme?.id ?? null,
    templates,
    destinations,
    history,
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const sourceShop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    // Source theme changed - re-list its templates.
    if (intent === "templates") {
      const themeId = String(formData.get("themeId"));
      return json({
        intent,
        templates: await listTemplateFiles(admin, themeId),
      });
    }

    if (intent === "review" || intent === "copy") {
      const sourceThemeId = String(formData.get("sourceThemeId"));
      const filenames = JSON.parse(String(formData.get("filenames") || "[]"));
      const targets = JSON.parse(String(formData.get("targets") || "[]"));

      if (filenames.length === 0) {
        return json({ intent, error: "Select at least one template to copy." }, { status: 400 });
      }
      if (targets.length === 0) {
        return json({ intent, error: "Select at least one destination store and theme." }, { status: 400 });
      }

      const themes = await listThemes(admin);
      const sourceTheme = themes.find((t) => t.id === sourceThemeId);
      if (!sourceTheme) {
        return json({ intent, error: "That source theme no longer exists." }, { status: 400 });
      }

      const sourceFiles = await readFiles(admin, sourceThemeId, filenames);

      // Review: diff each destination against the source, and report what the
      // copy would change. Run per target because two stores can be on different
      // theme versions and hold different images.
      if (intent === "review") {
        const checks = await Promise.all(
          targets.map(async (target) => {
            try {
              const review = await reviewTarget({
                targetShop: target.shop,
                targetThemeId: target.themeId,
                sourceFiles,
              });
              return { ...target, ...review };
            } catch (err) {
              return {
                ...target,
                missingSections: [],
                files: [],
                imagesReferenced: [],
                imagesMissing: [],
                imagesPresent: [],
                error: err?.message ?? String(err),
              };
            }
          }),
        );
        return json({ intent, checks });
      }

      const copyMediaEnabled = formData.get("copyMedia") === "true";
      const overwriteExistingMedia = formData.get("overwriteMedia") === "true";
      // The batch id is minted by the browser and passed in, because the browser
      // fires one request per destination (so each region can report its own
      // progress) and all of them belong to the one press of the button.
      const batchId = String(formData.get("batchId") || crypto.randomUUID());

      // One request copies to one store. Each resolves rather than throws, so a
      // dead store reports its own failure instead of taking the others with it.
      const results = [];
      for (const target of targets) {
        results.push(
          await copyToTarget({
            batchId,
            sourceShop,
            sourceAdmin: admin,
            sourceTheme,
            sourceFiles,
            targetShop: target.shop,
            targetThemeId: target.themeId,
            copyMediaEnabled,
            overwriteExistingMedia,
            copiedBy: session.onlineAccessInfo?.associated_user?.email ?? null,
          }),
        );
      }
      return json({ intent, results });
    }

    // History only - cheap enough to re-fetch once the fan-out has finished,
    // rather than having every in-flight copy request compute a stale copy of it.
    if (intent === "history") {
      return json({ intent, history: await recentCopies(sourceShop) });
    }

    // Undo a copy: restore what the destination theme held before it.
    if (intent === "revert") {
      const logIds = JSON.parse(String(formData.get("logIds") || "[]"));
      const reverts = [];
      for (const logId of logIds) {
        try {
          reverts.push(await revertCopy(logId, sourceShop));
        } catch (err) {
          reverts.push({
            logId,
            reverted: false,
            results: [],
            error: err?.message ?? String(err),
          });
        }
      }
      return json({
        intent,
        reverts,
        history: await recentCopies(sourceShop),
      });
    }

    return json({ intent, error: `Unknown intent: ${intent}` }, { status: 400 });
  } catch (err) {
    return json({ intent, error: err?.message ?? String(err) }, { status: 500 });
  }
};

const roleBadge = (role) => {
  if (role === "MAIN") return <Badge tone="success">Live</Badge>;
  if (role === "DEVELOPMENT") return <Badge tone="info">Development</Badge>;
  return <Badge>Unpublished</Badge>;
};

const shopLabel = (info) =>
  `${info.name}${info.flag ? ` ${info.flag}` : ""}`;

const editedOn = (iso) => {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

// Themes are listed newest-edited first, so the edit date is part of the label:
// it's what tells you which "v1.6.5 | Heather" you're actually looking at.
// The same file can be missing on two destinations; the wizard talks about the
// set of files, not the per-store rows.
const dedupeMedia = (refs) => {
  const byKey = new Map();
  for (const ref of refs) byKey.set(`${ref.kind}:${ref.filename}`, ref);
  return [...byKey.values()].sort((a, b) => a.filename.localeCompare(b.filename));
};

const mediaNoun = (refs) => {
  const videos = refs.filter((r) => r.kind === "VIDEO").length;
  const images = refs.length - videos;
  const parts = [];
  if (images) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  if (videos) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  return parts.join(" and ") || "nothing";
};

const themeLabel = (theme) =>
  `${theme.name}${theme.role === "MAIN" ? " (live)" : ""} - edited ${editedOn(theme.updatedAt)}`;

// Polaris exposes no style hook on Autocomplete.TextField, so the theme field is
// styled by class: the pointer cursor says "this is a picker, click it" rather
// than the I-beam a bare text input implies (it is still type-to-search), and the
// chosen theme is bold because it's the one value on the page you re-read most.
// The live theme is the one that can hurt you, so it is red wherever it appears:
// as an option in the list, and in the field once it's the selection.
const THEME_PICKER_STYLES = `
  .tc-theme-picker input {
    cursor: pointer;
    font-weight: 600;
  }
  .tc-theme-picker--live input {
    background: var(--p-color-bg-surface-critical);
    color: var(--p-color-text-critical);
  }
  .tc-live-theme {
    display: block;
    width: 100%;
    padding: var(--p-space-100) var(--p-space-200);
    border-radius: var(--p-border-radius-100);
    background: var(--p-color-bg-surface-critical);
    color: var(--p-color-text-critical);
    font-weight: 600;
  }
`;

// A type-to-search theme picker. These stores carry 100+ themes, so a plain
// <Select> is unusable - you scroll a wall of near-identical campaign names.
function ThemePicker({ label, labelHidden, themes, value, onChange, disabled }) {
  // `text` is the plain string: it's what the field shows and what search
  // filters on. `label` is what the list renders, which for the live theme is a
  // red row rather than the bare text.
  const options = useMemo(
    () =>
      themes.map((t) => {
        const text = themeLabel(t);
        return {
          value: t.id,
          text,
          label:
            t.role === "MAIN" ? <span className="tc-live-theme">{text}</span> : text,
        };
      }),
    [themes],
  );

  const [input, setInput] = useState("");
  const [filtered, setFiltered] = useState(options);

  // Reflect the selected theme back into the field, and reset the filter, when
  // the selection or the theme list changes from outside.
  useEffect(() => {
    setInput(options.find((o) => o.value === value)?.text ?? "");
    setFiltered(options);
  }, [value, options]);

  const updateInput = (next) => {
    setInput(next);
    const q = next.trim().toLowerCase();
    setFiltered(
      q ? options.filter((o) => o.text.toLowerCase().includes(q)) : options,
    );
  };

  const select = ([selectedId]) => {
    onChange(selectedId);
    setInput(options.find((o) => o.value === selectedId)?.text ?? "");
  };

  const liveSelected = themes.find((t) => t.id === value)?.role === "MAIN";

  return (
    <div
      className={`tc-theme-picker${liveSelected ? " tc-theme-picker--live" : ""}`}
    >
      <Autocomplete
        options={filtered}
        selected={value ? [value] : []}
        onSelect={select}
        textField={
          <Autocomplete.TextField
            label={label}
            labelHidden={labelHidden}
            value={input}
            onChange={updateInput}
            placeholder="Search themes by name"
            autoComplete="off"
            disabled={disabled}
            clearButton
            onClearButtonClick={() => updateInput("")}
          />
        }
      />
    </div>
  );
}

export default function TemplateCopierPage() {
  const { source, themes, initialThemeId, templates, destinations, history } =
    useLoaderData();

  const templatesFetcher = useFetcher();
  const copyFetcher = useFetcher();
  const revertFetcher = useFetcher();
  const historyFetcher = useFetcher();

  const [sourceThemeId, setSourceThemeId] = useState(initialThemeId ?? "");
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  // { [shop]: themeId } - a shop is a destination once it has a theme chosen.
  const [targetThemes, setTargetThemes] = useState({});
  const [enabledShops, setEnabledShops] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [liveAcknowledged, setLiveAcknowledged] = useState(false);
  const [overwriteAccepted, setOverwriteAccepted] = useState(false);
  const [step, setStep] = useState(0);
  const [copyMedia, setCopyMedia] = useState(true);
  const [overwriteMedia, setOverwriteMedia] = useState(false);
  // { [shop]: { state: "COPYING" | "DONE" | "FAILED", result } } - one entry per
  // destination, updated as that region's request comes back.
  const [copyProgress, setCopyProgress] = useState(null);

  const sourceTemplates =
    templatesFetcher.data?.intent === "templates"
      ? templatesFetcher.data.templates
      : templates;

  const loadingTemplates = templatesFetcher.state !== "idle";

  const review =
    copyFetcher.data?.intent === "review" ? copyFetcher.data.checks : null;

  // Copy state comes from the per-region fan-out, not a fetcher.
  const progressEntries = copyProgress ? Object.entries(copyProgress) : [];
  const copying = progressEntries.some(([, p]) => p.state === "COPYING");
  const copyFinished = progressEntries.length > 0 && !copying;
  const results = copyFinished
    ? progressEntries.map(([, p]) => p.result).filter(Boolean)
    : null;
  const busy = copyFetcher.state !== "idle" || copying;

  const actionError = copyFetcher.data?.error ?? revertFetcher.data?.error ?? null;
  const reverts =
    revertFetcher.data?.intent === "revert" ? revertFetcher.data.reverts : null;
  // Whichever fetcher last touched the history wins.
  const currentHistory =
    revertFetcher.data?.history ?? historyFetcher.data?.history ?? history;

  const sourceTheme = themes.find((t) => t.id === sourceThemeId) ?? null;

  const visibleTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sourceTemplates;
    return sourceTemplates.filter((f) => f.filename.toLowerCase().includes(q));
  }, [sourceTemplates, search]);

  // Selecting a different source theme invalidates the current selection -
  // the same filename in another theme is a different file.
  const changeSourceTheme = (id) => {
    setSourceThemeId(id);
    setSelected([]);
    templatesFetcher.submit(
      { intent: "templates", themeId: id },
      { method: "post" },
    );
  };

  const toggleFile = (filename) =>
    setSelected((prev) =>
      prev.includes(filename)
        ? prev.filter((f) => f !== filename)
        : [...prev, filename],
    );

  const toggleShop = (shop) => {
    setEnabledShops((prev) =>
      prev.includes(shop) ? prev.filter((s) => s !== shop) : [...prev, shop],
    );
    // Default a newly-enabled store to its live theme - the common case - but the
    // copy still can't run until you've been through the confirm modal.
    setTargetThemes((prev) => {
      if (prev[shop]) return prev;
      const dest = destinations.find((d) => d.shop === shop);
      const main = dest?.themes.find((t) => t.role === "MAIN") ?? dest?.themes[0];
      return main ? { ...prev, [shop]: main.id } : prev;
    });
  };

  const targets = useMemo(
    () =>
      enabledShops
        .filter((shop) => targetThemes[shop])
        .map((shop) => {
          const dest = destinations.find((d) => d.shop === shop);
          const theme = dest?.themes.find((t) => t.id === targetThemes[shop]);
          return {
            shop,
            name: dest ? shopLabel(dest) : shop,
            themeId: targetThemes[shop],
            themeName: theme?.name ?? "",
            role: theme?.role ?? "",
          };
        }),
    [enabledShops, targetThemes, destinations],
  );

  // "🇦🇺 or 🇺🇸 or 🇪🇺" - the flags of the stores you can actually copy into,
  // so the heading names the choice rather than describing it.
  const destinationFlags = destinations
    .map((d) => d.flag)
    .filter(Boolean)
    .join(" or ");

  const liveTargets = targets.filter((t) => t.role === "MAIN");
  const canCopy = selected.length > 0 && targets.length > 0 && sourceThemeId;

  const openConfirm = () => {
    setLiveAcknowledged(false);
    setOverwriteAccepted(false);
    setStep(0);
    setModalOpen(true);
    copyFetcher.submit(
      {
        intent: "review",
        sourceThemeId,
        filenames: JSON.stringify(selected),
        targets: JSON.stringify(targets.map(({ shop, themeId }) => ({ shop, themeId }))),
      },
      { method: "post" },
    );
  };

  // The copy fans out: one POST per destination, all in flight at once, each
  // reporting back on its own. That's what makes per-region progress possible -
  // a single request for all four stores can only tell you "still going".
  // Rate limits are per-store, so running them concurrently costs nothing.
  const runCopy = async () => {
    const batchId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());

    setCopyProgress(
      Object.fromEntries(
        targets.map((t) => [t.shop, { state: "COPYING", result: null }]),
      ),
    );

    const post = async (target) => {
      const body = new FormData();
      body.set("intent", "copy");
      body.set("batchId", batchId);
      body.set("sourceThemeId", sourceThemeId);
      body.set("filenames", JSON.stringify(selected));
      body.set(
        "targets",
        JSON.stringify([{ shop: target.shop, themeId: target.themeId }]),
      );
      body.set("copyMedia", String(copyMedia));
      body.set("overwriteMedia", String(overwriteMedia));

      try {
        // App Bridge patches fetch to carry the session token, so this is
        // authenticated the same way a Remix fetcher submit would be. The search
        // string is kept because the embedded app's URL carries shop/host.
        const res = await fetch(
          `${window.location.pathname}${window.location.search}`,
          { method: "POST", body },
        );
        const data = await res.json();
        const result = data.results?.[0] ?? null;

        setCopyProgress((prev) => ({
          ...prev,
          [target.shop]: {
            state: result?.status === "SUCCESS" ? "DONE" : "FAILED",
            result:
              result ??
              // The request itself failed (500, auth, network): synthesise a
              // result so the region reports the reason rather than hanging.
              {
                targetShop: target.shop,
                targetThemeId: target.themeId,
                targetThemeName: target.themeName,
                fileCount: selected.length,
                successCount: 0,
                status: "FAILED",
                files: [],
                media: [],
                error: data.error ?? `Request failed (HTTP ${res.status})`,
              },
          },
        }));
      } catch (err) {
        setCopyProgress((prev) => ({
          ...prev,
          [target.shop]: {
            state: "FAILED",
            result: {
              targetShop: target.shop,
              targetThemeId: target.themeId,
              targetThemeName: target.themeName,
              fileCount: selected.length,
              successCount: 0,
              status: "FAILED",
              files: [],
              media: [],
              error: err?.message ?? String(err),
            },
          },
        }));
      }
    };

    await Promise.all(targets.map(post));

    // Every region has reported; pull the history back in one go.
    historyFetcher.submit({ intent: "history" }, { method: "post" });
  };

  const runRevert = (logIds) => {
    revertFetcher.submit(
      { intent: "revert", logIds: JSON.stringify(logIds) },
      { method: "post" },
    );
  };

  // Close the modal once every region has reported; results render on the page.
  useEffect(() => {
    if (copyFinished) setModalOpen(false);
  }, [copyFinished]);

  const reviewing =
    copyFetcher.state !== "idle" &&
    copyFetcher.formData?.get("intent") === "review";

  const doneCount = progressEntries.filter(([, p]) => p.state !== "COPYING").length;
  const percentComplete = progressEntries.length
    ? Math.round((doneCount / progressEntries.length) * 100)
    : 0;

  // A destination we couldn't even inspect. The copy will almost certainly fail
  // for that store, so say so before the button is pressed, not after.
  const reviewErrors = review?.filter((c) => c.error) ?? [];
  const missingSectionsFound =
    review?.some((c) => c.missingSections?.length > 0) ?? false;

  // Images and videos referenced by the selected templates, and how they land on
  // each destination: some stores may already have a file of that name, some not.
  const mediaReferenced = review?.[0]?.mediaReferenced ?? [];
  const mediaToCreate = dedupeMedia(
    (review ?? []).flatMap((c) => c.mediaMissing ?? []),
  );
  const mediaConflicts = dedupeMedia(
    (review ?? []).flatMap((c) => c.mediaPresent ?? []),
  );

  // The wizard: review what changes, decide what happens to media, then accept.
  // The media step drops out when the templates reference none.
  const steps = useMemo(() => {
    const list = [{ id: "changes", title: "Review the changes" }];
    if (mediaReferenced.length > 0) {
      list.push({ id: "media", title: "Images and videos used by these templates" });
    }
    list.push({ id: "confirm", title: "Confirm and copy" });
    return list;
  }, [mediaReferenced.length]);

  const currentStep = steps[Math.min(step, steps.length - 1)];
  const isLastStep = step >= steps.length - 1;
  const acceptedEverything =
    overwriteAccepted && (liveTargets.length === 0 || liveAcknowledged);

  const totalChanged = (review ?? []).reduce(
    (n, c) => n + (c.changedCount ?? 0),
    0,
  );
  const totalNew = (review ?? []).reduce((n, c) => n + (c.newCount ?? 0), 0);
  const totalIdentical = (review ?? []).reduce(
    (n, c) => n + (c.identicalCount ?? 0),
    0,
  );

  return (
    <Page>
      <TitleBar title="Template copier" />
      <style>{THEME_PICKER_STYLES}</style>
      <Layout>
        <Layout.Section>
          <Text as="p" variant="bodyMd" tone="subdued">
            Copy theme templates from {shopLabel(source)} into a theme on another
            store. Files are overwritten in place; the destination theme's version
            history keeps the previous version, so a copy can be reverted from the
            theme editor timeline.
          </Text>
        </Layout.Section>

        {actionError && (
          <Layout.Section>
            <Banner tone="critical" title="Copy failed">
              <Text as="p">{actionError}</Text>
            </Banner>
          </Layout.Section>
        )}

        {results && (
          <Layout.Section>
            <ResultsBanner results={results} />
          </Layout.Section>
        )}

        {/* Step 1: which theme on this store, and which of its templates. */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="h2" variant="headingMd">
                    Step 1: Select template files from {shopLabel(source)}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {source.shop}
                  </Text>
                </BlockStack>
                {sourceTheme && roleBadge(sourceTheme.role)}
              </InlineStack>

              <ThemePicker
                label="Theme (most recently edited first)"
                themes={themes}
                value={sourceThemeId}
                onChange={changeSourceTheme}
                disabled={busy || loadingTemplates}
              />

              <Divider />

              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="050">
                  <Text as="h3" variant="headingSm">
                    {selected.length === 0
                      ? "No templates selected"
                      : `${selected.length} of ${sourceTemplates.length} templates selected`}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {selected.length === 0
                      ? "Choose the template files to copy."
                      : selected
                          .map((f) => f.replace(/^templates\//, ""))
                          .join(", ")}
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  {selected.length > 0 && (
                    <Button variant="plain" onClick={() => setSelected([])}>
                      Clear
                    </Button>
                  )}
                  <Button
                    onClick={() => setPickerOpen(true)}
                    disabled={loadingTemplates || busy || !sourceThemeId}
                    loading={loadingTemplates}
                  >
                    {selected.length === 0 ? "Select templates" : "Edit selection"}
                  </Button>
                </InlineStack>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Step 2: destinations, full width so each theme picker has room. */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="050">
                <Text as="h2" variant="headingMd">
                  {`Step 2: Choose the destination${destinationFlags ? ` (${destinationFlags})` : ""}`}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  Pick the stores to copy into, and the theme on each. Themes are
                  listed most recently edited first.
                </Text>
              </BlockStack>

              {destinations.length === 0 && (
                <Text as="p" tone="subdued">
                  The app isn't installed on any other store yet. Install it on the
                  other regional stores and they'll appear here.
                </Text>
              )}

              {destinations.map((dest) => {
                const enabled = enabledShops.includes(dest.shop);
                const chosen = dest.themes.find(
                  (t) => t.id === targetThemes[dest.shop],
                );

                return (
                  <Box
                    key={dest.shop}
                    padding="300"
                    borderRadius="200"
                    borderWidth="025"
                    borderColor={enabled ? "border-emphasis" : "border"}
                  >
                    <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="300">
                      <BlockStack gap="100">
                        <Checkbox
                          label={shopLabel(dest)}
                          helpText={dest.shop}
                          checked={enabled}
                          disabled={!dest.reachable || busy}
                          onChange={() => toggleShop(dest.shop)}
                        />
                      </BlockStack>

                      {enabled && dest.reachable ? (
                        <BlockStack gap="100">
                          <ThemePicker
                            label={`Destination theme on ${dest.name}`}
                            labelHidden
                            themes={dest.themes}
                            value={targetThemes[dest.shop] ?? ""}
                            onChange={(value) =>
                              setTargetThemes((prev) => ({
                                ...prev,
                                [dest.shop]: value,
                              }))
                            }
                            disabled={busy}
                          />
                          {chosen?.role === "MAIN" && (
                            <InlineStack gap="150" blockAlign="center">
                              <Badge tone="critical">Live theme</Badge>
                              <Text as="span" variant="bodySm" tone="subdued">
                                Changes go straight to customers.
                              </Text>
                            </InlineStack>
                          )}
                        </BlockStack>
                      ) : (
                        <Box />
                      )}
                    </InlineGrid>

                    {!dest.reachable && (
                      <Box paddingBlockStart="200">
                        <Banner tone="warning">
                          <Text as="p" variant="bodySm">
                            Can't reach this store: {dest.error}. Reinstall the app
                            there to restore access.
                          </Text>
                        </Banner>
                      </Box>
                    )}
                  </Box>
                );
              })}

              <Divider />

              <InlineStack align="end">
                <Button
                  variant="primary"
                  tone={liveTargets.length > 0 ? "critical" : undefined}
                  disabled={!canCopy || busy}
                  onClick={openConfirm}
                >
                  {`Copy ${selected.length} template${selected.length === 1 ? "" : "s"} to ${targets.length} store${targets.length === 1 ? "" : "s"}`}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {currentHistory.length > 0 && (
          <Layout.Section>
            <HistoryCard
              history={currentHistory}
              onRevert={runRevert}
              reverting={revertFetcher.state !== "idle"}
              reverts={reverts}
            />
          </Layout.Section>
        )}
      </Layout>

      {/* Step 1's picker. Selection is applied live, so "Done" just closes it. */}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={`Select templates from ${sourceTheme?.name ?? "theme"}`}
        primaryAction={{
          content: `Done${selected.length ? ` (${selected.length})` : ""}`,
          onAction: () => setPickerOpen(false),
        }}
        secondaryActions={[
          {
            content: "Select all",
            onAction: () =>
              setSelected(visibleTemplates.map((f) => f.filename)),
            disabled: visibleTemplates.length === 0,
          },
          {
            content: "Clear",
            onAction: () => setSelected([]),
            disabled: selected.length === 0,
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="Filter templates"
              labelHidden
              placeholder="Filter templates, e.g. product"
              value={search}
              onChange={setSearch}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setSearch("")}
            />

            <Text as="p" variant="bodySm" tone="subdued">
              {`${selected.length} of ${sourceTemplates.length} selected`}
              {search.trim()
                ? ` - showing ${visibleTemplates.length} match${visibleTemplates.length === 1 ? "" : "es"}`
                : ""}
            </Text>

            {visibleTemplates.length === 0 ? (
              <Text as="p" tone="subdued">
                No templates match.
              </Text>
            ) : (
              <Scrollable style={{ maxHeight: "420px" }}>
                <BlockStack gap="100">
                  {visibleTemplates.map((file) => (
                    <Box
                      key={file.filename}
                      padding="200"
                      background={
                        selected.includes(file.filename)
                          ? "bg-surface-selected"
                          : undefined
                      }
                      borderRadius="200"
                    >
                      <InlineStack align="space-between" blockAlign="center">
                        <Checkbox
                          label={file.filename.replace(/^templates\//, "")}
                          checked={selected.includes(file.filename)}
                          onChange={() => toggleFile(file.filename)}
                        />
                        <Text as="span" tone="subdued" variant="bodySm">
                          {(file.size / 1024).toFixed(1)} KB
                        </Text>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </Scrollable>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* The confirm wizard: what changes, what happens to images, then accept. */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        size="large"
        title={
          copying
            ? `Copying to ${targets.length} store${targets.length === 1 ? "" : "s"}...`
            : `${currentStep.title} (step ${step + 1} of ${steps.length})`
        }
        primaryAction={
          copying
            ? {
                content: `Copying... ${percentComplete}%`,
                loading: true,
                disabled: true,
                onAction: () => {},
              }
            : isLastStep
              ? {
                  content: `Yes, copy to ${targets.length} store${targets.length === 1 ? "" : "s"}`,
                  destructive: true,
                  disabled: !acceptedEverything || busy,
                  onAction: runCopy,
                }
              : {
                  content: "Next",
                  disabled: reviewing,
                  onAction: () => setStep((s) => s + 1),
                }
        }
        secondaryActions={
          copying
            ? []
            : [
                step > 0
                  ? { content: "Back", onAction: () => setStep((s) => s - 1) }
                  : { content: "Cancel", onAction: () => setModalOpen(false) },
              ]
        }
      >
        {copying ? (
          <Modal.Section>
            <CopyProgress
              targets={targets}
              progress={copyProgress}
              percentComplete={percentComplete}
              doneCount={doneCount}
            />
          </Modal.Section>
        ) : reviewing ? (
          <Modal.Section>
            <BlockStack gap="300" inlineAlign="center">
              <Spinner accessibilityLabel="Comparing templates" size="large" />
              <Text as="p" tone="subdued">
                Comparing your templates against each destination theme...
              </Text>
            </BlockStack>
          </Modal.Section>
        ) : currentStep.id === "changes" ? (
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p">
                {`Copying ${selected.length} template${selected.length === 1 ? "" : "s"} from `}
                <Text as="span" fontWeight="semibold">
                  {sourceTheme?.name}
                </Text>
                {`. The source overwrites whatever the destination has now.`}
              </Text>

              {/* The one-line, human-readable version of the whole operation. */}
              <Banner
                tone={totalChanged > 0 ? "warning" : "info"}
                title="In plain English"
              >
                <Text as="p" variant="bodySm">
                  {plainSummary({
                    targets: targets.length,
                    totalChanged,
                    totalNew,
                    totalIdentical,
                    mediaToCreate: copyMedia ? mediaToCreate : [],
                  })}
                </Text>
              </Banner>

              {reviewErrors.length > 0 && (
                <Banner tone="critical" title="Couldn't check a destination store">
                  <BlockStack gap="200">
                    {reviewErrors.map((c) => (
                      <Text as="p" variant="bodySm" key={c.shop}>
                        <Text as="span" fontWeight="semibold">
                          {c.shop}
                        </Text>
                        {`: ${c.error}`}
                      </Text>
                    ))}
                    <Text as="p" variant="bodySm">
                      Copying to that store will most likely fail. Go back and
                      deselect it, or continue and read the per-store result.
                    </Text>
                  </BlockStack>
                </Banner>
              )}

              {(review ?? [])
                .filter((c) => !c.error)
                .map((c) => (
                  <TargetDiff key={c.shop} check={c} targets={targets} />
                ))}

              {missingSectionsFound && (
                <Banner tone="warning" title="Some sections are missing">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm">
                      These templates reference sections the destination theme
                      doesn't have. Only templates are copied, not section code, so
                      those sections render as nothing until the section files exist
                      on the destination theme.
                    </Text>
                    {(review ?? [])
                      .filter((c) => c.missingSections?.length > 0)
                      .map((c) => (
                        <Text as="p" variant="bodySm" key={c.shop}>
                          <Text as="span" fontWeight="semibold">
                            {c.shop}
                          </Text>
                          {`: ${c.missingSections.join(", ")}`}
                        </Text>
                      ))}
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>
          </Modal.Section>
        ) : currentStep.id === "media" ? (
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p">
                {`These templates reference ${mediaNoun(mediaReferenced)} from this store's Files. A template that lands without its media renders broken, so the files are copied across too, under the same filenames the templates point at.`}
              </Text>

              <Checkbox
                label="Copy referenced images and videos into the destination store's Files"
                helpText={
                  mediaToCreate.length > 0
                    ? `${mediaNoun(mediaToCreate)} missing on at least one destination store.`
                    : "Every referenced file already exists on the destination stores."
                }
                checked={copyMedia}
                onChange={setCopyMedia}
              />

              {/* The filename collision question. Same filename usually means the
                  same asset, and replacing it changes every other page that uses
                  it - so keeping the destination's copy is the default. */}
              {copyMedia && mediaConflicts.length > 0 && (
                <Box
                  padding="300"
                  borderRadius="200"
                  borderWidth="025"
                  borderColor="border"
                >
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      {`${mediaNoun(mediaConflicts)} already exist on the destination store with the same filename`}
                    </Text>
                    <ChoiceList
                      title="What should happen to those?"
                      titleHidden
                      choices={[
                        {
                          label: "Keep the destination store's existing file",
                          value: "keep",
                          helpText:
                            "The template still resolves, because the filename matches. Other pages using that file are untouched.",
                        },
                        {
                          label: "Overwrite with the file from this store",
                          value: "overwrite",
                          helpText:
                            "Replaces the file on the destination store. Every other page there that uses it changes too, and this can't be reverted.",
                        },
                      ]}
                      selected={[overwriteMedia ? "overwrite" : "keep"]}
                      onChange={([value]) =>
                        setOverwriteMedia(value === "overwrite")
                      }
                    />
                    <MediaList refs={mediaConflicts} maxHeight="120px" />
                  </BlockStack>
                </Box>
              )}

              {copyMedia && mediaToCreate.length > 0 && (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    {`${mediaNoun(mediaToCreate)} will be uploaded to the destination store`}
                  </Text>
                  <MediaList refs={mediaToCreate} maxHeight="160px" />
                  {mediaToCreate.some((r) => r.kind === "VIDEO") && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Videos are downloaded and re-uploaded (Shopify won't ingest a
                      video from a URL), so a copy with videos takes longer. Files
                      over 250 MB are skipped and reported.
                    </Text>
                  )}
                </BlockStack>
              )}

              {!copyMedia && mediaToCreate.length > 0 && (
                <Banner tone="warning" title="Media will be missing">
                  <Text as="p" variant="bodySm">
                    {`${mediaNoun(mediaToCreate)} referenced by these templates ${mediaToCreate.length === 1 ? "isn't" : "aren't"} on the destination store. Those render as broken until someone uploads them by hand under the same filename.`}
                  </Text>
                </Banner>
              )}
            </BlockStack>
          </Modal.Section>
        ) : (
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">
                Here's what happens when you press the button
              </Text>

              <List>
                {targets.map((t) => {
                  const check = (review ?? []).find((c) => c.shop === t.shop);
                  return (
                    <List.Item key={t.shop}>
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <Text as="span">
                          {`${t.name} - ${t.themeName}: `}
                          <Text as="span" fontWeight="semibold">
                            {check
                              ? `${check.changedCount} overwritten, ${check.newCount} created, ${check.identicalCount} unchanged`
                              : "not checked"}
                          </Text>
                        </Text>
                        {t.role === "MAIN" && (
                          <Badge tone="critical">Live theme</Badge>
                        )}
                      </InlineStack>
                    </List.Item>
                  );
                })}
                {copyMedia && mediaToCreate.length > 0 && (
                  <List.Item>
                    <Text as="span">
                      {`${mediaNoun(mediaToCreate)} uploaded to the destination store's Files`}
                    </Text>
                  </List.Item>
                )}
                {copyMedia && overwriteMedia && mediaConflicts.length > 0 && (
                  <List.Item>
                    <Text as="span" tone="critical">
                      {`${mediaNoun(mediaConflicts)} on the destination store overwritten`}
                    </Text>
                  </List.Item>
                )}
              </List>

              <Text as="p" tone="subdued" variant="bodySm">
                The templates are revertable: this page snapshots what each
                destination theme held before the copy, so Recent copies can put it
                back. Overwritten images and videos cannot be reverted.
              </Text>

              <Checkbox
                label="I accept that the source theme overwrites these templates on the destination stores"
                checked={overwriteAccepted}
                onChange={setOverwriteAccepted}
              />

              {liveTargets.length > 0 && (
                <Banner tone="critical" title="This changes a live storefront">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm">
                      {`${liveTargets.map((t) => t.name).join(", ")} ${liveTargets.length === 1 ? "is" : "are"} receiving these templates on the live theme. Customers see the change immediately.`}
                    </Text>
                    <Checkbox
                      label="I understand this goes live straight away"
                      checked={liveAcknowledged}
                      onChange={setLiveAcknowledged}
                    />
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>
          </Modal.Section>
        )}
      </Modal>
    </Page>
  );
}

// The whole operation in one sentence, for the person who is about to press a
// destructive button and wants to know what it does.
function plainSummary({
  targets,
  totalChanged,
  totalNew,
  totalIdentical,
  mediaToCreate,
}) {
  const parts = [];
  const store = `${targets} store${targets === 1 ? "" : "s"}`;

  if (totalChanged) {
    parts.push(
      `overwrite ${totalChanged} existing template${totalChanged === 1 ? "" : "s"}`,
    );
  }
  if (totalNew) {
    parts.push(`create ${totalNew} new template${totalNew === 1 ? "" : "s"}`);
  }
  if (mediaToCreate.length) {
    parts.push(`upload ${mediaNoun(mediaToCreate)}`);
  }
  if (!parts.length) {
    return `Nothing changes. Every selected template is already identical on all ${store}.`;
  }

  const tail = totalIdentical
    ? ` ${totalIdentical} template${totalIdentical === 1 ? " is" : "s are"} already identical and will be rewritten with the same content.`
    : "";

  return `Across ${store}, this will ${parts.join(", ")}.${tail}`;
}

// Live progress while the copy runs. Each region is its own request, so each one
// reports for itself: still going, done, or failed - and the bar tracks how many
// regions have finished. A region that fails doesn't stall the others.
function CopyProgress({ targets, progress, percentComplete, doneCount }) {
  return (
    <BlockStack gap="400">
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" variant="bodySm" fontWeight="semibold">
            {`${doneCount} of ${targets.length} store${targets.length === 1 ? "" : "s"} done`}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {`${percentComplete}%`}
          </Text>
        </InlineStack>
        <ProgressBar progress={percentComplete} size="small" tone="primary" />
      </BlockStack>

      {targets.map((target) => {
        const entry = progress?.[target.shop];
        const result = entry?.result;

        return (
          <InlineStack
            key={target.shop}
            align="space-between"
            blockAlign="center"
            gap="300"
          >
            <InlineStack gap="300" blockAlign="center">
              {entry?.state === "COPYING" ? (
                <Spinner accessibilityLabel={`Copying to ${target.name}`} size="small" />
              ) : (
                <Badge tone={entry?.state === "DONE" ? "success" : "critical"}>
                  {entry?.state === "DONE" ? "Done" : "Failed"}
                </Badge>
              )}
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {target.name}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {target.themeName}
                </Text>
              </BlockStack>
            </InlineStack>

            <Text as="span" variant="bodySm" tone={result?.error ? "critical" : "subdued"}>
              {entry?.state === "COPYING"
                ? "Copying templates and media..."
                : result?.error
                  ? result.error
                  : result
                    ? `${result.successCount}/${result.fileCount} templates${
                        result.media?.length
                          ? `, ${result.media.filter((m) => m.status === "COPIED" || m.status === "OVERWRITTEN").length} media`
                          : ""
                      }`
                    : ""}
            </Text>
          </InlineStack>
        );
      })}
    </BlockStack>
  );
}

// A scrollable list of media filenames, tagged image or video.
function MediaList({ refs, maxHeight }) {
  return (
    <Scrollable style={{ maxHeight }}>
      <BlockStack gap="100">
        {refs.map((ref) => (
          <InlineStack
            key={`${ref.kind}:${ref.filename}`}
            gap="200"
            blockAlign="center"
          >
            <Badge tone={ref.kind === "VIDEO" ? "info" : undefined}>
              {ref.kind === "VIDEO" ? "Video" : "Image"}
            </Badge>
            <Text as="span" variant="bodySm">
              {ref.filename}
            </Text>
          </InlineStack>
        ))}
      </BlockStack>
    </Scrollable>
  );
}

// What one destination store gets: a line per template, saying what changes in
// it. "4 sections edited, 12 setting values changed" is the answer to "what am I
// actually about to do to the US store".
function TargetDiff({ check, targets }) {
  const target = targets.find((t) => t.shop === check.shop);

  return (
    <Box padding="300" borderRadius="200" borderWidth="025" borderColor="border">
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h3" variant="headingSm">
            {target?.name ?? check.shop}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {target?.themeName}
          </Text>
          {target?.role === "MAIN" && <Badge tone="critical">Live theme</Badge>}
        </InlineStack>

        {check.files.map((file) => (
          <InlineStack key={file.filename} gap="200" blockAlign="start" wrap={false}>
            <Box minWidth="90px">
              <Badge
                tone={
                  file.status === "NEW"
                    ? "success"
                    : file.status === "IDENTICAL"
                      ? undefined
                      : "warning"
                }
              >
                {file.status === "NEW"
                  ? "New"
                  : file.status === "IDENTICAL"
                    ? "Same"
                    : "Overwrite"}
              </Badge>
            </Box>
            <BlockStack gap="050">
              <Text as="span" variant="bodySm" fontWeight="semibold">
                {file.filename.replace(/^templates\//, "")}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {file.summary}
              </Text>
              {/* Name the sections, so "4 sections edited" is checkable. */}
              {file.changed?.length > 0 && (
                <Text as="span" variant="bodySm" tone="subdued">
                  {`Sections: ${file.changed
                    .map(
                      (s) =>
                        `${s.type}${s.settings.length ? ` (${s.settings.length} setting${s.settings.length === 1 ? "" : "s"})` : ""}`,
                    )
                    .join(", ")}`}
                </Text>
              )}
            </BlockStack>
          </InlineStack>
        ))}
      </BlockStack>
    </Box>
  );
}

// Results, per destination store. A failure is worth more than a red banner: it
// reports whether the whole store failed (bad token, missing scope, theme gone)
// or only some files did, and prints the exact message Shopify returned for each
// one, so the fix doesn't require digging through server logs.
function ResultsBanner({ results }) {
  const failed = results.filter((r) => r.status !== "SUCCESS");
  const tone =
    failed.length === 0
      ? "success"
      : failed.length === results.length
        ? "critical"
        : "warning";

  return (
    <Banner
      tone={tone}
      title={
        failed.length === 0
          ? "Templates copied"
          : failed.length === results.length
            ? "Copy failed"
            : "Copied with problems"
      }
    >
      <BlockStack gap="300">
        {results.map((r) => {
          const failedFiles = r.files.filter((f) => f.status !== "SUCCESS");
          const media = r.media ?? [];
          const mediaCopied = media.filter(
            (i) => i.status === "COPIED" || i.status === "OVERWRITTEN",
          );
          const mediaFailed = media.filter((i) => i.status === "FAILED");

          return (
            <BlockStack gap="100" key={`${r.targetShop}-${r.targetThemeId}`}>
              <InlineStack gap="200" blockAlign="center">
                <Badge
                  tone={
                    r.status === "SUCCESS"
                      ? "success"
                      : r.status === "PARTIAL"
                        ? "warning"
                        : "critical"
                  }
                >
                  {r.status}
                </Badge>
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {r.targetShop}
                </Text>
                <Text as="span" variant="bodySm">
                  {`${r.targetThemeName}: ${r.successCount}/${r.fileCount} copied`}
                </Text>
              </InlineStack>

              {/* A store-level error: nothing was written to this store at all. */}
              {r.error && (
                <Box paddingInlineStart="300">
                  <Text as="p" variant="bodySm" tone="critical">
                    {r.error}
                  </Text>
                </Box>
              )}

              {/* File-level errors: the rest of the store's files did land. */}
              {!r.error && failedFiles.length > 0 && (
                <Box paddingInlineStart="300">
                  <List type="bullet">
                    {failedFiles.map((f) => (
                      <List.Item key={f.filename}>
                        <Text as="span" variant="bodySm">
                          <Text as="span" fontWeight="semibold">
                            {f.filename}
                          </Text>
                          {`: ${f.error ?? "Unknown error"}`}
                        </Text>
                      </List.Item>
                    ))}
                  </List>
                </Box>
              )}

              {media.length > 0 && (
                <Box paddingInlineStart="300">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`Images and videos: ${mediaCopied.length} copied, ${media.length - mediaCopied.length - mediaFailed.length} already present`}
                    {mediaFailed.length ? `, ${mediaFailed.length} failed` : ""}
                  </Text>
                  {mediaFailed.length > 0 && (
                    <List type="bullet">
                      {mediaFailed.map((i) => (
                        <List.Item key={`${i.kind}:${i.filename}`}>
                          <Text as="span" variant="bodySm" tone="critical">
                            {`${i.filename}: ${i.error}`}
                          </Text>
                        </List.Item>
                      ))}
                    </List>
                  )}
                </Box>
              )}
            </BlockStack>
          );
        })}
      </BlockStack>
    </Banner>
  );
}

// History, one block per batch - a batch being one press of the Copy button, so
// "3 templates to US, UK and EU at 15:29" reads as the single thing it was.
// Each destination in a batch can be reverted on its own, or the whole batch at
// once: the pre-copy contents of every template were snapshotted, so putting them
// back is exact rather than a trip through the theme editor's timeline.
function HistoryCard({ history, onRevert, reverting, reverts }) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Recent copies
        </Text>

        {reverts && (
          <Banner
            tone={reverts.every((r) => r.reverted) ? "success" : "critical"}
            title={
              reverts.every((r) => r.reverted)
                ? "Reverted"
                : "Revert didn't fully work"
            }
          >
            <BlockStack gap="100">
              {reverts.map((r, i) => (
                <Text as="p" variant="bodySm" key={`${r.targetShop ?? i}`}>
                  {r.reverted
                    ? `${r.targetShop} (${r.targetThemeName}): ${r.results.filter((x) => x.status === "RESTORED").length} restored, ${r.results.filter((x) => x.status === "DELETED").length} deleted`
                    : `${r.targetShop ?? "Copy"}: ${r.error}`}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        )}

        {history.map((batch) => {
          const revertableIds = batch.targets
            .filter((t) => t.revertable)
            .map((t) => t.id);

          return (
            <Box
              key={batch.batchId}
              padding="300"
              borderRadius="200"
              borderWidth="025"
              borderColor="border"
            >
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="start" gap="300">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Badge
                        tone={
                          batch.status === "SUCCESS"
                            ? "success"
                            : batch.status === "PARTIAL"
                              ? "warning"
                              : "critical"
                        }
                      >
                        {batch.status}
                      </Badge>
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {new Date(batch.createdAt).toLocaleString()}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`${batch.targets.length} store${batch.targets.length === 1 ? "" : "s"}`}
                        {batch.copiedBy ? ` - ${batch.copiedBy}` : ""}
                      </Text>
                    </InlineStack>

                    {/* Which templates this batch actually copied. */}
                    <Text as="p" variant="bodySm">
                      <Text as="span" tone="subdued">
                        {`From ${batch.sourceThemeName}: `}
                      </Text>
                      {batch.templates
                        .map((f) => f.replace(/^templates\//, ""))
                        .join(", ")}
                    </Text>
                  </BlockStack>

                  {revertableIds.length > 0 && (
                    <Button
                      tone="critical"
                      variant="secondary"
                      loading={reverting}
                      onClick={() => onRevert(revertableIds)}
                    >
                      {revertableIds.length === batch.targets.length
                        ? "Revert all"
                        : "Revert"}
                    </Button>
                  )}
                </InlineStack>

                <Divider />

                {batch.targets.map((t) => (
                  <InlineStack
                    key={t.id}
                    align="space-between"
                    blockAlign="center"
                    gap="300"
                  >
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge
                          tone={
                            t.status === "SUCCESS"
                              ? "success"
                              : t.status === "PARTIAL"
                                ? "warning"
                                : "critical"
                          }
                        >
                          {t.status}
                        </Badge>
                        <Text as="span" variant="bodySm">
                          {`${t.targetShop} - ${t.targetThemeName}`}
                        </Text>
                        {t.targetThemeRole === "MAIN" && (
                          <Badge tone="critical">Live</Badge>
                        )}
                        {t.revertedAt && <Badge>Reverted</Badge>}
                      </InlineStack>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`${t.successCount}/${t.fileCount} templates`}
                        {t.media?.length
                          ? `, ${t.media.filter((m) => m.status === "COPIED" || m.status === "OVERWRITTEN").length} media file(s) copied`
                          : ""}
                        {t.error ? ` - ${t.error}` : ""}
                      </Text>
                    </BlockStack>

                    {t.revertable && (
                      <Button
                        variant="plain"
                        tone="critical"
                        loading={reverting}
                        onClick={() => onRevert([t.id])}
                      >
                        Revert
                      </Button>
                    )}
                  </InlineStack>
                ))}
              </BlockStack>
            </Box>
          );
        })}

        <Text as="p" variant="bodySm" tone="subdued">
          Reverting restores each template to exactly what the destination theme
          held before the copy, and deletes templates the copy created. Images and
          videos are left alone.
        </Text>
      </BlockStack>
    </Card>
  );
}
