// Theme Manager - every store's themes in one screen, for deploy prep.
//
// The workflow this exists for: duplicate the live theme on each store, collect
// the new theme IDs, paste them into the deploy file, deploy. Doing that across
// four stores in the Shopify admin means four tabs, a lot of scrolling and
// copying IDs out of URLs. Here it's one page: duplicate in place, tick the
// themes you want, copy the IDs as a plain list.
//
// See app/lib/themeManager.server.js for the API side.

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
  InlineStack,
  Layout,
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  ClipboardIcon,
  CodeIcon,
  DeleteIcon,
  DuplicateIcon,
  LinkIcon,
  PaintBrushFlatIcon,
  TextBlockIcon,
  ViewIcon,
} from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  deleteTheme,
  duplicateTheme,
  listAllStoreThemes,
  publishTheme,
  refreshStoreThemes,
  renameTheme,
} from "../lib/themeManager.server";

// Defined here rather than imported from the .server lib: the component uses it,
// and Remix strips server modules out of the client bundle.
const numericThemeId = (gid) => String(gid ?? "").split("/").pop();

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const stores = await listAllStoreThemes(admin, session.shop);
  return json({ stores, embeddedShop: session.shop });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent"));
  const shop = String(formData.get("shop") || "");
  const themeId = String(formData.get("themeId") || "");

  try {
    let message = "";
    let newTheme = null;

    if (intent === "duplicate") {
      newTheme = await duplicateTheme(shop, themeId, String(formData.get("name") || ""));
      message = `Duplicated to "${newTheme.name}" (${numericThemeId(newTheme.id)})`;
    } else if (intent === "rename") {
      const theme = await renameTheme(shop, themeId, String(formData.get("name") || ""));
      message = `Renamed to "${theme?.name}"`;
    } else if (intent === "publish") {
      const theme = await publishTheme(shop, themeId);
      message = `"${theme?.name}" is now the live theme`;
    } else if (intent === "delete") {
      await deleteTheme(shop, themeId);
      message = "Theme deleted";
    } else if (intent !== "refresh") {
      return json({ intent, error: `Unknown intent: ${intent}` }, { status: 400 });
    }

    // Re-read just this store, so the row reflects reality without reloading
    // every store's themes.
    return json({
      intent,
      shop,
      message,
      newThemeId: newTheme?.id ?? null,
      themes: await refreshStoreThemes(shop),
    });
  } catch (err) {
    return json(
      { intent, shop, error: err?.message ?? String(err) },
      { status: 500 },
    );
  }
};

const storeHandle = (shop) => shop.replace(/\.myshopify\.com$/, "");

// The visual theme editor (Shopify calls this "Customize").
const editorUrl = (shop, themeGid) =>
  `https://admin.shopify.com/store/${storeHandle(shop)}/themes/${numericThemeId(themeGid)}/editor`;

// The code editor is the same path without /editor - Shopify's own shortcut for
// it is /admin/themes/current, i.e. /themes/<id> with no suffix.
const codeEditorUrl = (shop, themeGid) =>
  `https://admin.shopify.com/store/${storeHandle(shop)}/themes/${numericThemeId(themeGid)}`;

// The storefront rendered with this theme, without publishing it.
const previewUrl = (shop, themeGid) =>
  `https://${shop}/?preview_theme_id=${numericThemeId(themeGid)}`;

// Only the roles worth calling out get a badge. Nearly every theme is
// unpublished, so badging that adds noise to every row and says nothing - the
// absence of a Live badge already means "not live".
const roleBadge = (role) => {
  if (role === "MAIN") return <Badge tone="success">Live</Badge>;
  if (role === "DEVELOPMENT") return <Badge tone="info">Dev</Badge>;
  return null;
};

// Clipboard writes can be refused inside the admin iframe, so fall back to a
// hidden textarea + execCommand rather than failing silently.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

// A button that copies and briefly confirms it did, so there's feedback without
// a toast for every click.
function CopyButton({ label, value, icon, disabled }) {
  const [done, setDone] = useState(false);

  const onClick = async () => {
    if (await copyText(value)) {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }
  };

  return (
    <Button
      size="micro"
      icon={done ? CheckCircleIcon : icon}
      tone={done ? "success" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

const shopLabel = (store) =>
  `${store.name}${store.flag ? ` ${store.flag}` : ""}`;

// Server renders in UTC, browser in local time - pin both or React throws a
// hydration mismatch (see the same note in the Template copier).
const editedOn = (iso) =>
  iso
    ? new Intl.DateTimeFormat("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Australia/Sydney",
      }).format(new Date(iso))
    : "";

// How many themes each store shows before you ask for more.
const PAGE_SIZE = 6;

export default function ThemeManagerPage() {
  const { stores: initialStores } = useLoaderData();
  const fetcher = useFetcher();

  // Themes per store, kept locally so a mutation updates one store in place.
  const [storeThemes, setStoreThemes] = useState(() =>
    Object.fromEntries(initialStores.map((s) => [s.shop, s.themes])),
  );
  // Selected theme GIDs, across all stores - this is the deploy-file list.
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  // { shop, theme, mode: "duplicate" | "rename" | "publish" | "delete" }
  const [dialog, setDialog] = useState(null);
  const [nameDraft, setNameDraft] = useState("");
  // Gate for the two actions that can't be undone from here. Reset every time a
  // dialog opens, so a previous confirmation can never carry over.
  const [confirmed, setConfirmed] = useState(false);
  // These stores carry 100+ themes, so each store shows a page at a time.
  // { [shop]: howManyVisible }
  const [visibleCount, setVisibleCount] = useState({});

  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  // Fold a completed mutation back into the local theme lists, and auto-select a
  // freshly duplicated theme - it's the ID you came here for.
  useEffect(() => {
    if (!result?.themes || !result.shop) return;
    setStoreThemes((prev) => ({ ...prev, [result.shop]: result.themes }));
    if (result.newThemeId) {
      setSelected((prev) =>
        prev.includes(result.newThemeId) ? prev : [...prev, result.newThemeId],
      );
    }
    setDialog(null);
  }, [result]);

  const toggleSelected = (themeGid) =>
    setSelected((prev) =>
      prev.includes(themeGid)
        ? prev.filter((id) => id !== themeGid)
        : [...prev, themeGid],
    );

  const runIntent = (intent, shop, themeId, name) => {
    const body = { intent, shop, themeId };
    if (name !== undefined) body.name = name;
    fetcher.submit(body, { method: "post" });
  };

  const openDialog = (mode, shop, theme) => {
    setDialog({ mode, shop, theme });
    setConfirmed(false);
    setNameDraft(
      mode === "duplicate"
        ? `${theme.name} copy`
        : mode === "rename"
          ? theme.name
          : "",
    );
  };

  // Selected IDs in the order the stores are listed, newline separated - the
  // plain list that goes into the deploy file.
  const selectedIds = useMemo(() => {
    const ordered = [];
    for (const store of initialStores) {
      for (const theme of storeThemes[store.shop] ?? []) {
        if (selected.includes(theme.id)) ordered.push(numericThemeId(theme.id));
      }
    }
    return ordered;
  }, [initialStores, storeThemes, selected]);

  const copyIds = async () => {
    const text = selectedIds.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked in an iframe; the textarea below is the fallback.
      setCopied(false);
    }
  };

  const matches = (theme) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      theme.name.toLowerCase().includes(q) ||
      numericThemeId(theme.id).includes(q)
    );
  };

  // Every search starts each store back at the first 6 matches. Without this, a
  // store you'd expanded to 100 would dump 100 matches on you.
  useEffect(() => {
    setVisibleCount({});
  }, [search]);

  // Totals for the search summary line.
  const { totalMatches, storesWithMatches } = useMemo(() => {
    let total = 0;
    let stores = 0;
    for (const store of initialStores) {
      const n = (storeThemes[store.shop] ?? []).filter(matches).length;
      total += n;
      if (n > 0) stores += 1;
    }
    return { totalMatches: total, storesWithMatches: stores };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStores, storeThemes, search]);

  return (
    <Page fullWidth>
      <TitleBar title="Theme Manager" />
      <Layout>
        <Layout.Section>
          <Text as="p" variant="bodyMd" tone="subdued">
            Every store's themes in one view. Duplicate the live theme on each
            store, tick the new ones, and copy the IDs straight into your deploy
            file.
          </Text>
        </Layout.Section>

        {result?.error && (
          <Layout.Section>
            <Banner tone="critical" title="That didn't work">
              <Text as="p">{result.error}</Text>
            </Banner>
          </Layout.Section>
        )}

        {result?.message && !result?.error && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => {}}>
              <Text as="p">{result.message}</Text>
            </Banner>
          </Layout.Section>
        )}

        {/* Search sits above everything: it narrows every store at once, and
            each store falls back to showing the first 6 matches. */}
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <TextField
                label="Search themes across all stores"
                placeholder="Theme name or ID, e.g. Victoriana or 129901035592"
                value={search}
                onChange={setSearch}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setSearch("")}
              />
              {search.trim() && (
                <Text as="span" variant="bodySm" tone="subdued">
                  {`${totalMatches} matching theme${totalMatches === 1 ? "" : "s"} across ${storesWithMatches} store${storesWithMatches === 1 ? "" : "s"}`}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* The deploy-file basket: IDs collect here as you tick themes. */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="050">
                  <Text as="h2" variant="headingMd">
                    {`Theme IDs for deploy (${selectedIds.length} selected)`}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Tick themes below. Duplicating a theme selects the new one
                    automatically.
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  {selected.length > 0 && (
                    <Button variant="plain" onClick={() => setSelected([])}>
                      Clear
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    disabled={selectedIds.length === 0}
                    onClick={copyIds}
                  >
                    {copied ? "Copied" : "Copy IDs"}
                  </Button>
                </InlineStack>
              </InlineStack>

              {selectedIds.length > 0 && (
                // Also rendered as selectable text: clipboard writes can be
                // blocked inside the admin iframe, and this always works.
                <TextField
                  label="Selected theme IDs"
                  labelHidden
                  value={selectedIds.join("\n")}
                  multiline={Math.min(selectedIds.length, 8)}
                  readOnly
                  autoComplete="off"
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {initialStores.map((store) => {
          const allThemes = storeThemes[store.shop] ?? [];
          const matching = allThemes.filter(matches);
          const shown = visibleCount[store.shop] ?? PAGE_SIZE;
          const themes = matching.slice(0, shown);
          const remaining = matching.length - themes.length;
          const liveTheme = allThemes.find((t) => t.role === "MAIN");

          return (
            <Layout.Section key={store.shop}>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" gap="300">
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h2" variant="headingMd">
                          {shopLabel(store)}
                        </Text>
                        {store.isEmbedded && <Badge>This store</Badge>}
                      </InlineStack>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {search.trim()
                          ? `${store.shop} - ${matching.length} of ${allThemes.length} themes match`
                          : `${store.shop} - ${allThemes.length} themes`}
                      </Text>
                    </BlockStack>

                    {/* The deploy move: duplicate this store's live theme. */}
                    {liveTheme && (
                      <Button
                        disabled={busy}
                        onClick={() => openDialog("duplicate", store.shop, liveTheme)}
                      >
                        Duplicate live theme
                      </Button>
                    )}
                  </InlineStack>

                  {!store.reachable && (
                    <Banner tone="warning">
                      <Text as="p" variant="bodySm">
                        Can't reach this store: {store.error}. Reinstall the app
                        there to restore access.
                      </Text>
                    </Banner>
                  )}

                  {store.reachable && themes.length === 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      No themes match this filter.
                    </Text>
                  )}

                  {themes.length > 0 && (
                    <BlockStack gap="100">
                      {themes.map((theme, index) => (
                        <ThemeRow
                          key={theme.id}
                          shop={store.shop}
                          theme={theme}
                          index={index}
                          checked={selected.includes(theme.id)}
                          onToggle={() => toggleSelected(theme.id)}
                          onAction={(mode) => openDialog(mode, store.shop, theme)}
                          busy={busy}
                        />
                      ))}
                    </BlockStack>
                  )}

                  {remaining > 0 && (
                    <InlineStack gap="200" blockAlign="center">
                      <Button
                        onClick={() =>
                          setVisibleCount((prev) => ({
                            ...prev,
                            [store.shop]: shown + PAGE_SIZE,
                          }))
                        }
                      >
                        {`Load ${Math.min(PAGE_SIZE, remaining)} more`}
                      </Button>
                      <Button
                        variant="plain"
                        onClick={() =>
                          setVisibleCount((prev) => ({
                            ...prev,
                            [store.shop]: matching.length,
                          }))
                        }
                      >
                        {`Show all ${matching.length}`}
                      </Button>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`${remaining} more`}
                      </Text>
                    </InlineStack>
                  )}

                  {/* Collapse back down once you've expanded a long list. */}
                  {remaining === 0 && shown > PAGE_SIZE && matching.length > PAGE_SIZE && (
                    <InlineStack>
                      <Button
                        variant="plain"
                        onClick={() =>
                          setVisibleCount((prev) => ({
                            ...prev,
                            [store.shop]: PAGE_SIZE,
                          }))
                        }
                      >
                        Show fewer
                      </Button>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          );
        })}
      </Layout>

      <ThemeDialog
        dialog={dialog}
        nameDraft={nameDraft}
        setNameDraft={setNameDraft}
        confirmed={confirmed}
        setConfirmed={setConfirmed}
        onClose={() => setDialog(null)}
        onConfirm={runIntent}
        busy={busy}
      />
    </Page>
  );
}

// One theme: tick it for the deploy list, open it, preview it, or act on it.
function ThemeRow({ shop, theme, index, checked, onToggle, onAction, busy }) {
  const isLive = theme.role === "MAIN";
  // Zebra striping: with two lines of controls per row, alternating backgrounds
  // are what keep one theme's actions visually attached to its name. Selection
  // still wins, since that's the state you're tracking for the deploy list.
  const background = checked
    ? "bg-surface-selected"
    : index % 2 === 1
      ? "bg-surface-secondary"
      : undefined;

  return (
    <Box padding="300" borderRadius="200" background={background}>
      <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <Checkbox
            label=""
            labelHidden
            checked={checked}
            onChange={onToggle}
          />
          <BlockStack gap="050">
            <InlineStack gap="200" blockAlign="center" wrap>
              <Text as="span" variant="bodySm" fontWeight="semibold">
                {theme.name}
              </Text>
              {/* The ID is the thing this page exists to hand you. */}
              <Badge tone={checked ? "info" : undefined}>
                {numericThemeId(theme.id)}
              </Badge>
              {roleBadge(theme.role)}
              {theme.processing && <Badge tone="attention">Processing</Badge>}
            </InlineStack>
            <Text as="span" variant="bodySm" tone="subdued">
              {`Edited ${editedOn(theme.updatedAt)}`}
            </Text>
          </BlockStack>
        </InlineStack>

        {/* Row 1: what you do to the theme, Preview first because it's the one
            you reach for most. Row 2: the code editor and the two clipboard
            shortcuts - the things you use while wiring up a deploy. Links render
            as buttons too (Polaris Button takes a url), so both rows are one
            consistent set of controls. */}
        <BlockStack gap="100" inlineAlign="end">
          {/* Row 1 is the primary set: bordered buttons with icons. */}
          <InlineStack gap="150" blockAlign="center" wrap>
            <Button
              size="slim"
              icon={ViewIcon}
              url={previewUrl(shop, theme.id)}
              target="_blank"
            >
              Preview
            </Button>
            {/* Shopify's own naming: "Customize" is the visual editor. */}
            <Button
              size="slim"
              icon={PaintBrushFlatIcon}
              url={editorUrl(shop, theme.id)}
              target="_blank"
            >
              Customize
            </Button>
            <Button
              size="slim"
              icon={DuplicateIcon}
              disabled={busy}
              onClick={() => onAction("duplicate")}
            >
              Duplicate
            </Button>
            <Button
              size="slim"
              icon={TextBlockIcon}
              disabled={busy}
              onClick={() => onAction("rename")}
            >
              Rename
            </Button>
            {!isLive && (
              <Button
                size="slim"
                icon={CheckCircleIcon}
                disabled={busy || theme.processing}
                onClick={() => onAction("publish")}
              >
                Publish
              </Button>
            )}
            {!isLive && (
              <Button
                size="slim"
                icon={DeleteIcon}
                tone="critical"
                disabled={busy}
                onClick={() => onAction("delete")}
              >
                Delete
              </Button>
            )}
          </InlineStack>

          {/* Row 2 is secondary: bordered like row 1, but a size smaller so it
              still reads as the quieter set. Copy ID leads - it's the one you
              press most while filling in a deploy file - with the other copy
              shortcut beside it and the code editor last. */}
          <InlineStack gap="150" blockAlign="center" wrap>
            <CopyButton
              label="Copy ID"
              icon={ClipboardIcon}
              value={numericThemeId(theme.id)}
            />
            <CopyButton
              label="Copy preview link"
              icon={LinkIcon}
              value={previewUrl(shop, theme.id)}
            />
            <Button
              size="micro"
              icon={CodeIcon}
              url={codeEditorUrl(shop, theme.id)}
              target="_blank"
            >
              Edit code
            </Button>
          </InlineStack>
        </BlockStack>
      </InlineStack>
    </Box>
  );
}

// Duplicate and rename take a name; publish and delete just need confirming.
// Publishing and deleting are the two that can hurt, so they say what they do
// in plain terms rather than "Are you sure?".
function ThemeDialog({
  dialog,
  nameDraft,
  setNameDraft,
  confirmed,
  setConfirmed,
  onClose,
  onConfirm,
  busy,
}) {
  if (!dialog) return null;
  const { mode, shop, theme } = dialog;
  const needsName = mode === "duplicate" || mode === "rename";
  // Publishing changes what customers see; deleting is permanent. Both need an
  // explicit tick before the button unlocks - a modal alone is too easy to
  // click through.
  const needsAcknowledgement = mode === "publish" || mode === "delete";

  const title =
    mode === "duplicate"
      ? `Duplicate "${theme.name}"?`
      : mode === "rename"
        ? `Rename "${theme.name}"`
        : mode === "publish"
          ? `Are you sure you want to publish "${theme.name}"?`
          : `Are you sure you want to delete "${theme.name}"?`;

  const confirmLabel =
    mode === "duplicate"
      ? "Yes, duplicate"
      : mode === "rename"
        ? "Rename"
        : mode === "publish"
          ? "Yes, publish to live"
          : "Yes, delete theme";

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      primaryAction={{
        content: confirmLabel,
        destructive: mode === "publish" || mode === "delete",
        loading: busy,
        disabled:
          busy ||
          (needsName && !nameDraft.trim()) ||
          (needsAcknowledgement && !confirmed),
        onAction: () =>
          onConfirm(mode, shop, theme.id, needsName ? nameDraft : undefined),
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p" variant="bodySm" tone="subdued">
            {`${shop} - theme ${numericThemeId(theme.id)}`}
          </Text>

          {needsName && (
            <TextField
              label={mode === "duplicate" ? "Name for the new theme" : "Theme name"}
              value={nameDraft}
              onChange={setNameDraft}
              autoComplete="off"
              helpText={
                mode === "duplicate"
                  ? "The duplicate is created unpublished. Its ID is selected for you once it exists."
                  : undefined
              }
            />
          )}

          {mode === "publish" && (
            <Banner tone="critical" title="This changes the live storefront">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm">
                  Customers on {shop} see this theme immediately. The current live
                  theme becomes unpublished - to undo, publish it back.
                </Text>
                <Checkbox
                  label="I understand this goes live straight away"
                  checked={confirmed}
                  onChange={setConfirmed}
                />
              </BlockStack>
            </Banner>
          )}

          {mode === "delete" && (
            <Banner tone="critical" title="This can't be undone">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm">
                  The theme and its files are removed from {shop} permanently.
                  There is no revert.
                </Text>
                <Checkbox
                  label="I understand this permanently deletes the theme"
                  checked={confirmed}
                  onChange={setConfirmed}
                />
              </BlockStack>
            </Banner>
          )}

          {mode === "duplicate" && theme.role === "MAIN" && (
            <Text as="p" variant="bodySm" tone="subdued">
              Duplicating the live theme doesn't affect customers - the copy is
              created unpublished.
            </Text>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
