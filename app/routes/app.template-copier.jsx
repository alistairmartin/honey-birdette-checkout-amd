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
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Layout,
  List,
  Modal,
  Page,
  Scrollable,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  copyToTarget,
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
  const initialTheme = themes[0] ?? null;

  const [templates, shops, history] = await Promise.all([
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
    sourceShop,
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

const themeLabel = (theme) =>
  `${theme.name}${theme.role === "MAIN" ? " (live)" : ""}`;

export default function TemplateCopierPage() {
  const { sourceShop, themes, initialThemeId, templates, destinations, history } =
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
    setEnabledShops((prev) => {
      if (prev.includes(shop)) return prev.filter((s) => s !== shop);
      return [...prev, shop];
    });
    // Default a newly-enabled store to its live theme - the common case - but
    // the copy still can't run until you've looked at the confirm modal.
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
            name: dest?.name ?? shop,
            themeId: targetThemes[shop],
            themeName: theme?.name ?? "",
            role: theme?.role ?? "",
          };
        }),
    [enabledShops, targetThemes, destinations],
  );

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
            Copy theme templates from {sourceShop} into a theme on another store.
            Files are overwritten in place; the destination theme's version history
            keeps the previous version, so a copy can be reverted from the theme
            editor timeline.
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

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Source: {sourceShop}
                </Text>
                {sourceTheme && roleBadge(sourceTheme.role)}
              </InlineStack>

              <Select
                label="Theme"
                options={themes.map((t) => ({
                  label: themeLabel(t),
                  value: t.id,
                }))}
                value={sourceThemeId}
                onChange={changeSourceTheme}
                disabled={busy || loadingTemplates}
              />

              <Divider />

              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Templates ({selected.length} of {sourceTemplates.length} selected)
                </Text>
                <InlineStack gap="200">
                  <Button
                    variant="plain"
                    onClick={() =>
                      setSelected(visibleTemplates.map((f) => f.filename))
                    }
                    disabled={loadingTemplates || visibleTemplates.length === 0}
                  >
                    Select all
                  </Button>
                  <Button
                    variant="plain"
                    onClick={() => setSelected([])}
                    disabled={selected.length === 0}
                  >
                    Clear
                  </Button>
                </InlineStack>
              </InlineStack>

              <TextField
                label="Filter"
                labelHidden
                placeholder="Filter templates, e.g. product"
                value={search}
                onChange={setSearch}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setSearch("")}
              />

              {loadingTemplates ? (
                <Text as="p" tone="subdued">
                  Loading templates...
                </Text>
              ) : visibleTemplates.length === 0 ? (
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
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Destinations
                </Text>

                {destinations.length === 0 && (
                  <Text as="p" tone="subdued">
                    The app isn't installed on any other store yet. Install it on
                    the other regional stores and they'll appear here.
                  </Text>
                )}

                {destinations.map((dest) => {
                  const enabled = enabledShops.includes(dest.shop);
                  return (
                    <BlockStack gap="200" key={dest.shop}>
                      <Checkbox
                        label={dest.name}
                        helpText={dest.shop}
                        checked={enabled}
                        disabled={!dest.reachable || busy}
                        onChange={() => toggleShop(dest.shop)}
                      />
                      {!dest.reachable && (
                        <Banner tone="warning">
                          <Text as="p" variant="bodySm">
                            Can't reach this store: {dest.error}. Reinstall the app
                            there to restore access.
                          </Text>
                        </Banner>
                      )}
                      {enabled && dest.reachable && (
                        <Box paddingInlineStart="600">
                          <Select
                            label="Theme"
                            labelHidden
                            options={dest.themes.map((t) => ({
                              label: themeLabel(t),
                              value: t.id,
                            }))}
                            value={targetThemes[dest.shop] ?? ""}
                            onChange={(value) =>
                              setTargetThemes((prev) => ({
                                ...prev,
                                [dest.shop]: value,
                              }))
                            }
                            disabled={busy}
                          />
                        </Box>
                      )}
                    </BlockStack>
                  );
                })}

                <Divider />

                <Button
                  variant="primary"
                  tone={liveTargets.length > 0 ? "critical" : undefined}
                  disabled={!canCopy || busy}
                  onClick={openConfirm}
                >
                  {`Copy ${selected.length} template${selected.length === 1 ? "" : "s"} to ${targets.length} store${targets.length === 1 ? "" : "s"}`}
                </Button>
              </BlockStack>
            </Card>

            {currentHistory.length > 0 && <HistoryCard history={currentHistory} />}
          </BlockStack>
        </Layout.Section>
      </Layout>

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
  const tone = failed.length === 0 ? "success" : failed.length === results.length ? "critical" : "warning";

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
              {`${row.successCount}/${row.fileCount} from ${row.sourceThemeName} → ${row.targetShop} (${row.targetThemeName})`}
              {row.copiedBy ? ` by ${row.copiedBy}` : ""}
            </Text>
          </BlockStack>
        ))}
      </BlockStack>
    </Card>
  );
}
