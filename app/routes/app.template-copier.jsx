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
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Modal,
  Page,
  Scrollable,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  copyToTarget,
  getShopInfo,
  listDestinationShops,
  listTemplateFiles,
  listThemes,
  listThemesForShop,
  preflightMissingSections,
  readFiles,
  recentCopies,
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

    if (intent === "preflight" || intent === "copy") {
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

      // Preflight: which sections does each destination theme not have? Run per
      // target because two stores can be on different theme versions.
      if (intent === "preflight") {
        const checks = await Promise.all(
          targets.map(async (target) => {
            try {
              const { admin: targetAdmin } = await unauthenticated.admin(target.shop);
              const missingSections = await preflightMissingSections(
                targetAdmin,
                target.themeId,
                sourceFiles,
              );
              return { ...target, missingSections, error: null };
            } catch (err) {
              return {
                ...target,
                missingSections: [],
                error: err?.message ?? String(err),
              };
            }
          }),
        );
        return json({ intent, checks });
      }

      // Copy. Targets run in sequence so a rate limit on one store doesn't
      // cascade, and each resolves rather than throws - one dead store can't
      // take the others down with it.
      const results = [];
      for (const target of targets) {
        results.push(
          await copyToTarget({
            sourceShop,
            sourceTheme,
            sourceFiles,
            targetShop: target.shop,
            targetThemeId: target.themeId,
            copiedBy: session.onlineAccessInfo?.associated_user?.email ?? null,
          }),
        );
      }
      return json({ intent, results, history: await recentCopies(sourceShop) });
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
const themeLabel = (theme) =>
  `${theme.name}${theme.role === "MAIN" ? " (live)" : ""} - edited ${editedOn(theme.updatedAt)}`;

// A type-to-search theme picker. These stores carry 100+ themes, so a plain
// <Select> is unusable - you scroll a wall of near-identical campaign names.
function ThemePicker({ label, labelHidden, themes, value, onChange, disabled }) {
  const options = useMemo(
    () => themes.map((t) => ({ value: t.id, label: themeLabel(t) })),
    [themes],
  );

  const [input, setInput] = useState("");
  const [filtered, setFiltered] = useState(options);

  // Reflect the selected theme back into the field, and reset the filter, when
  // the selection or the theme list changes from outside.
  useEffect(() => {
    setInput(options.find((o) => o.value === value)?.label ?? "");
    setFiltered(options);
  }, [value, options]);

  const updateInput = (next) => {
    setInput(next);
    const q = next.trim().toLowerCase();
    setFiltered(
      q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options,
    );
  };

  const select = ([selectedId]) => {
    onChange(selectedId);
    setInput(options.find((o) => o.value === selectedId)?.label ?? "");
  };

  return (
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
  );
}

export default function TemplateCopierPage() {
  const { source, themes, initialThemeId, templates, destinations, history } =
    useLoaderData();

  const templatesFetcher = useFetcher();
  const copyFetcher = useFetcher();

  const [sourceThemeId, setSourceThemeId] = useState(initialThemeId ?? "");
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  // { [shop]: themeId } - a shop is a destination once it has a theme chosen.
  const [targetThemes, setTargetThemes] = useState({});
  const [enabledShops, setEnabledShops] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [liveAcknowledged, setLiveAcknowledged] = useState(false);

  const sourceTemplates =
    templatesFetcher.data?.intent === "templates"
      ? templatesFetcher.data.templates
      : templates;

  const busy = copyFetcher.state !== "idle";
  const loadingTemplates = templatesFetcher.state !== "idle";

  const preflight =
    copyFetcher.data?.intent === "preflight" ? copyFetcher.data.checks : null;
  const results =
    copyFetcher.data?.intent === "copy" ? copyFetcher.data.results : null;
  const actionError = copyFetcher.data?.error ?? null;
  const currentHistory = copyFetcher.data?.history ?? history;

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
    setModalOpen(true);
    copyFetcher.submit(
      {
        intent: "preflight",
        sourceThemeId,
        filenames: JSON.stringify(selected),
        targets: JSON.stringify(targets.map(({ shop, themeId }) => ({ shop, themeId }))),
      },
      { method: "post" },
    );
  };

  const runCopy = () => {
    copyFetcher.submit(
      {
        intent: "copy",
        sourceThemeId,
        filenames: JSON.stringify(selected),
        targets: JSON.stringify(targets.map(({ shop, themeId }) => ({ shop, themeId }))),
      },
      { method: "post" },
    );
  };

  // Close the modal once the copy comes back; results render on the page.
  useEffect(() => {
    if (results) setModalOpen(false);
  }, [results]);

  const missingSectionsFound =
    preflight?.some((c) => c.missingSections.length > 0) ?? false;

  return (
    <Page>
      <TitleBar title="Template copier" />
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
            <HistoryCard history={currentHistory} />
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

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Copy templates to other stores?"
        primaryAction={{
          content: "Copy templates",
          destructive: true,
          loading: busy && copyFetcher.formData?.get("intent") === "copy",
          disabled: (liveTargets.length > 0 && !liveAcknowledged) || busy,
          onAction: runCopy,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p">
              {`Copying ${selected.length} template${selected.length === 1 ? "" : "s"} from `}
              <Text as="span" fontWeight="semibold">
                {sourceTheme?.name}
              </Text>
              {" into:"}
            </Text>

            <List>
              {targets.map((t) => (
                <List.Item key={t.shop}>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span">
                      {t.name} - {t.themeName}
                    </Text>
                    {t.role === "MAIN" && <Badge tone="critical">Live theme</Badge>}
                  </InlineStack>
                </List.Item>
              ))}
            </List>

            <Text as="p" tone="subdued" variant="bodySm">
              Templates with the same filename are overwritten. Each destination
              theme's version history keeps the previous version, so you can revert
              from the theme editor timeline.
            </Text>

            {copyFetcher.state !== "idle" &&
              copyFetcher.formData?.get("intent") === "preflight" && (
                <Text as="p" tone="subdued">
                  Checking destination themes...
                </Text>
              )}

            {missingSectionsFound && (
              <Banner tone="warning" title="Some sections are missing">
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm">
                    These templates reference sections the destination theme
                    doesn't have. Only templates are copied, not section code, so
                    those sections will render as nothing until the section files
                    exist on the destination theme.
                  </Text>
                  {preflight
                    .filter((c) => c.missingSections.length > 0)
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
      </Modal>
    </Page>
  );
}

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
      <BlockStack gap="200">
        {results.map((r) => (
          <Text as="p" variant="bodySm" key={`${r.targetShop}-${r.targetThemeId}`}>
            <Text as="span" fontWeight="semibold">
              {r.targetShop}
            </Text>
            {` - ${r.targetThemeName}: ${r.successCount}/${r.fileCount} copied`}
            {r.error ? ` - ${r.error}` : ""}
            {!r.error && r.status !== "SUCCESS"
              ? ` - failed: ${r.files
                  .filter((f) => f.status !== "SUCCESS")
                  .map((f) => `${f.filename} (${f.error})`)
                  .join("; ")}`
              : ""}
          </Text>
        ))}
      </BlockStack>
    </Banner>
  );
}

function HistoryCard({ history }) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Recent copies
        </Text>
        {history.map((row) => (
          <BlockStack gap="100" key={row.id}>
            <InlineStack gap="200" blockAlign="center">
              <Badge
                tone={
                  row.status === "SUCCESS"
                    ? "success"
                    : row.status === "PARTIAL"
                      ? "warning"
                      : "critical"
                }
              >
                {row.status}
              </Badge>
              <Text as="span" variant="bodySm">
                {new Date(row.createdAt).toLocaleString()}
              </Text>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              {`${row.successCount}/${row.fileCount} from ${row.sourceThemeName} to ${row.targetShop} (${row.targetThemeName})`}
              {row.copiedBy ? ` by ${row.copiedBy}` : ""}
            </Text>
          </BlockStack>
        ))}
      </BlockStack>
    </Card>
  );
}
