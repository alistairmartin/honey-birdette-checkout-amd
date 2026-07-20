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
  Collapsible,
  Divider,
  Icon,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Modal,
  Page,
  ProgressBar,
  Scrollable,
  Spinner,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PaintBrushFlatIcon,
  ViewIcon,
} from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  getShopInfo,
  listDestinationShops,
  listTemplateFiles,
  listTemplateFilesForShop,
  listThemes,
  listThemesForShop,
  readFiles,
  recentCopies,
  revertCopy,
  reviewTarget,
  sortStoresByRegion,
} from "../lib/themeCopier.server";

// The copy and history endpoint. A resource route, so it always answers JSON -
// see the comment in app/routes/api.template-copy.jsx.
const COPY_ENDPOINT = "/api/template-copy";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const embeddedShop = session.shop;

  // Every store the app is installed on, embedded one first, each with its
  // themes loaded up front so switching source or destination in the pickers is
  // instant. Any of these can be the source you copy FROM or a destination you
  // copy INTO - the UI just stops you copying a theme onto itself.
  const [embeddedInfo, otherShops, history] = await Promise.all([
    getShopInfo(admin, embeddedShop).catch(() => ({
      shop: embeddedShop,
      name: embeddedShop,
      flag: "",
      reachable: true,
    })),
    listDestinationShops(embeddedShop),
    recentCopies(embeddedShop),
  ]);

  const embeddedThemes = await listThemes(admin);

  const otherStores = await Promise.all(
    otherShops.map(async (shop) => {
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

  // Always AU, UK, EU, US, so the stores sit in the same order here as on Theme
  // Dev regardless of which store the app is open in.
  const stores = sortStoresByRegion([
    { ...embeddedInfo, isEmbedded: true, reachable: true, themes: embeddedThemes },
    ...otherStores,
  ]);

  // Default source: the store you're in, on its most-recently-edited theme -
  // nearly always the one you just finished and now want to push out.
  const initialTheme = embeddedThemes[0] ?? null;
  const templates = initialTheme
    ? await listTemplateFiles(admin, initialTheme.id)
    : [];

  return json({
    embeddedShop,
    stores,
    initialSourceShop: embeddedShop,
    initialThemeId: initialTheme?.id ?? null,
    templates,
    history,
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const embeddedShop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  // The source can be any installed store, not just the one we're embedded in.
  // Reuse the embedded admin when they're the same, otherwise load the chosen
  // store's offline session.
  const adminForSource = async (shop) =>
    shop && shop !== embeddedShop
      ? (await unauthenticated.admin(shop)).admin
      : admin;

  try {
    // Source store or theme changed - re-list the chosen theme's templates.
    if (intent === "templates") {
      const themeId = String(formData.get("themeId"));
      const sourceShop = String(formData.get("sourceShop") || embeddedShop);
      const templates =
        sourceShop === embeddedShop
          ? await listTemplateFiles(admin, themeId)
          : await listTemplateFilesForShop(sourceShop, themeId);
      return json({ intent, templates });
    }

    // Review: diff each destination against the source and report what the copy
    // would change. Run per target because two stores can be on different theme
    // versions and hold different media.
    //
    // The copy itself is NOT here - it lives in /api/template-copy (a resource
    // route), because the browser fires one request per destination so each
    // region can report its own progress, and a plain fetch() POST to a page
    // route is a document request that comes back as HTML, not JSON.
    if (intent === "review") {
      const sourceShop = String(formData.get("sourceShop") || embeddedShop);
      const sourceThemeId = String(formData.get("sourceThemeId"));
      const filenames = JSON.parse(String(formData.get("filenames") || "[]"));
      const targets = JSON.parse(String(formData.get("targets") || "[]"));

      if (filenames.length === 0) {
        return json({ intent, error: "Select at least one template to copy." }, { status: 400 });
      }
      if (targets.length === 0) {
        return json({ intent, error: "Select at least one destination store and theme." }, { status: 400 });
      }

      const sourceAdmin = await adminForSource(sourceShop);
      const themes = await listThemes(sourceAdmin);
      const sourceTheme = themes.find((t) => t.id === sourceThemeId);
      if (!sourceTheme) {
        return json({ intent, error: "That source theme no longer exists." }, { status: 400 });
      }

      const sourceFiles = await readFiles(sourceAdmin, sourceThemeId, filenames);

      const checks = await Promise.all(
        targets.map(async (target) => {
          try {
            const review = await reviewTarget({
              targetShop: target.shop,
              targetThemeId: target.themeId,
              sourceFiles,
              sourceAdmin,
              sourceThemeId,
            });
            return { ...target, ...review };
          } catch (err) {
            return {
              ...target,
              dependenciesToCopy: [],
              dependenciesUnresolved: [],
              files: [],
              mediaReferenced: [],
              mediaMissing: [],
              mediaPresent: [],
              mediaMissingOnSource: [],
              error: err?.message ?? String(err),
            };
          }
        }),
      );
      return json({ intent, checks });
    }

    // Undo a copy: restore what the destination theme held before it.
    if (intent === "revert") {
      const logIds = JSON.parse(String(formData.get("logIds") || "[]"));
      const reverts = [];
      for (const logId of logIds) {
        try {
          reverts.push(await revertCopy(logId, embeddedShop));
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
        history: await recentCopies(embeddedShop),
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

// Results and history only carry the raw shop domain (it's what's in the copy
// log), so the flag has to be looked up from the loaded stores. Returns e.g.
// "🇺🇸 honey-birdette-usa.myshopify.com", falling back to the bare domain for a
// store that's since been uninstalled.
const makeShopDomainLabel = (stores) => {
  const flags = new Map(stores.map((s) => [s.shop, s.flag]));
  return (shop) => {
    const flag = flags.get(shop);
    return flag ? `${flag} ${shop}` : shop;
  };
};

// Dates are formatted with an explicit locale AND timezone, never the system
// default. The server renders in UTC and the browser renders in the viewer's
// zone, so `toLocaleDateString(undefined, ...)` produces two different strings
// for the same instant - React sees the mismatch on hydration and throws (#418,
// #423, #425). Pinning both makes server and client agree, and the team is in
// Sydney, so that's the zone worth showing.
const DATE_LOCALE = "en-AU";
const DATE_ZONE = "Australia/Sydney";

const editedOn = (iso) => {
  if (!iso) return "";
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: DATE_ZONE,
  }).format(new Date(iso));
};

const copiedAt = (iso) => {
  if (!iso) return "";
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DATE_ZONE,
  }).format(new Date(iso));
};

// Themes are listed newest-edited first, so the edit date is part of the label:
// it's what tells you which "v1.6.5 | Heather" you're actually looking at.
// A deep link into the destination store's theme editor, opened on the template
// that was just copied. The editor takes the template *name*, not the filename:
// "templates/page.bridal-edit.json" is "?template=page.bridal-edit", and
// "templates/customers/login.liquid" is "?template=customers/login" (the slash
// has to survive encoding).
function themeEditorUrl(shopDomain, themeGid, filename) {
  const handle = shopDomain.replace(/\.myshopify\.com$/, "");
  const themeId = String(themeGid).split("/").pop();
  const base = `https://admin.shopify.com/store/${handle}/themes/${themeId}/editor`;

  if (!filename) return base;

  const template = filename
    .replace(/^templates\//, "")
    .replace(/\.(json|liquid)$/, "");

  return `${base}?template=${encodeURIComponent(template).replace(/%2F/g, "/")}`;
}

// The storefront rendered with this theme. Note this is the shop home on that
// theme, not the specific template - a template filename doesn't map to a URL
// (a page template only resolves once a page is assigned to it), so linking the
// theme root is the honest option.
const storefrontPreviewUrl = (shopDomain, themeGid) =>
  `https://${shopDomain}/?preview_theme_id=${String(themeGid).split("/").pop()}`;

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

// The numeric part of a theme GID ("gid://shopify/OnlineStoreTheme/123" -> "123").
// That's the ID shown in the theme editor URL, so it's the one worth surfacing
// when a store carries a dozen themes with near-identical names.
const themeNumericId = (gid) => String(gid ?? "").split("/").pop();

// The ID is part of the searchable text as well as a badge, so you can paste a
// theme ID straight from an admin URL into the picker and land on it.
const themeLabel = (theme) =>
  `${theme.name}${theme.role === "MAIN" ? " (live)" : ""} - edited ${editedOn(theme.updatedAt)} - #${themeNumericId(theme.id)}`;

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
  /* The history disclosure toggle is a bare, left-aligned button - no native
     chrome, so it reads as the summary row it wraps. */
  .tc-batch-toggle {
    appearance: none;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    text-align: left;
    cursor: pointer;
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

// Choose several themes within one store. The autocomplete adds a theme and
// clears itself so you can add another; chosen themes show below as removable
// tags. A checkbox list would be unusable against 100+ near-identical campaign
// names, which is the whole reason the source picker is a search too.
function MultiThemePicker({ label, themes, selectedIds, onToggle, disabled, hint }) {
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

  useEffect(() => setFiltered(options), [options]);

  const updateInput = (next) => {
    setInput(next);
    const q = next.trim().toLowerCase();
    setFiltered(
      q ? options.filter((o) => o.text.toLowerCase().includes(q)) : options,
    );
  };

  const select = (chosen) => {
    // Autocomplete hands back the full selection; the newly-clicked id is the
    // one not already in our set. Toggle it, then reset the field.
    const added = chosen.find((id) => !selectedIds.includes(id)) ?? chosen[0];
    if (added) onToggle(added);
    setInput("");
    setFiltered(options);
  };

  const chosenThemes = selectedIds
    .map((id) => themes.find((t) => t.id === id))
    .filter(Boolean);

  return (
    <BlockStack gap="200">
      <div className="tc-theme-picker">
        <Autocomplete
          allowMultiple
          options={filtered}
          selected={selectedIds}
          onSelect={select}
          textField={
            <Autocomplete.TextField
              label={label}
              labelHidden
              value={input}
              onChange={updateInput}
              placeholder={
                selectedIds.length ? "Add another theme" : "Search themes to add"
              }
              autoComplete="off"
              disabled={disabled}
              clearButton
              onClearButtonClick={() => updateInput("")}
            />
          }
        />
      </div>

      {chosenThemes.length > 0 ? (
        <InlineStack gap="200" wrap>
          {chosenThemes.map((theme) => (
            <Tag key={theme.id} onRemove={disabled ? undefined : () => onToggle(theme.id)}>
              <InlineStack gap="100" blockAlign="center">
                {theme.role === "MAIN" && <Badge tone="critical">Live</Badge>}
                <Text as="span" variant="bodySm">
                  {theme.name}
                </Text>
                <Badge>{themeNumericId(theme.id)}</Badge>
              </InlineStack>
            </Tag>
          ))}
        </InlineStack>
      ) : (
        <Text as="span" variant="bodySm" tone="subdued">
          No themes chosen yet.
        </Text>
      )}

      {hint && (
        <Text as="span" variant="bodySm" tone="subdued">
          {hint}
        </Text>
      )}
    </BlockStack>
  );
}

export default function TemplateCopierPage() {
  const { stores, initialSourceShop, initialThemeId, templates, history } =
    useLoaderData();

  const templatesFetcher = useFetcher();
  const copyFetcher = useFetcher();
  const revertFetcher = useFetcher();
  const historyFetcher = useFetcher();

  // The store you copy FROM - any installed store, defaulting to the one you're
  // embedded in. `source` and `themes` derive from it.
  const [sourceShop, setSourceShop] = useState(initialSourceShop);
  const source = stores.find((s) => s.shop === sourceShop) ?? stores[0];
  const themes = source?.themes ?? [];

  const shopDomainLabel = useMemo(() => makeShopDomainLabel(stores), [stores]);

  // Every store is a possible destination, including the source itself (copy into
  // another of its own themes). `isSource` is computed, not baked, because the
  // source store changes.
  const destinations = stores.map((s) => ({
    ...s,
    isSource: s.shop === sourceShop,
  }));

  const [sourceThemeId, setSourceThemeId] = useState(initialThemeId ?? "");
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  // { [shop]: themeId[] } - a shop can copy into several of its own themes at
  // once. A shop is a destination once it has at least one theme chosen.
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

  // Selecting a different source theme invalidates the current selection - the
  // same filename in another theme is a different file. It can also make a
  // same-store destination point at the source theme (copying onto itself), so
  // that theme is dropped from the source store's destination set.
  const changeSourceTheme = (id, shop = sourceShop) => {
    setSourceThemeId(id);
    setSelected([]);
    setTargetThemes((prev) => {
      if (!prev[shop]?.includes(id)) return prev;
      return { ...prev, [shop]: prev[shop].filter((t) => t !== id) };
    });
    templatesFetcher.submit(
      { intent: "templates", sourceShop: shop, themeId: id },
      { method: "post" },
    );
  };

  // Switch the store you copy FROM. Its most-recently-edited theme becomes the
  // source theme (and its templates load), and anything already picked from the
  // old source is cleared - templates and selections don't carry across stores.
  const changeSourceStore = (shop) => {
    if (shop === sourceShop) return;
    setSourceShop(shop);
    const store = stores.find((s) => s.shop === shop);
    const firstTheme = store?.themes[0];
    setSelected([]);
    if (firstTheme) {
      setSourceThemeId(firstTheme.id);
      changeSourceTheme(firstTheme.id, shop);
    } else {
      setSourceThemeId("");
    }
  };

  const toggleFile = (filename) =>
    setSelected((prev) =>
      prev.includes(filename)
        ? prev.filter((f) => f !== filename)
        : [...prev, filename],
    );

  // Ticking a store only opens its theme picker - it never picks a theme for
  // you. Defaulting to the live theme would mean one stray click could target a
  // production storefront, so the destination theme is always a deliberate
  // choice.
  const toggleShop = (shop) => {
    setEnabledShops((prev) =>
      prev.includes(shop) ? prev.filter((s) => s !== shop) : [...prev, shop],
    );
  };

  // Add or remove one theme within a store's destination set.
  const toggleTargetTheme = (shop, themeId) => {
    setTargetThemes((prev) => {
      const current = prev[shop] ?? [];
      return {
        ...prev,
        [shop]: current.includes(themeId)
          ? current.filter((t) => t !== themeId)
          : [...current, themeId],
      };
    });
  };

  // One entry per (store, theme) the copy will write to. A same-store copy into
  // the source theme is filtered out defensively - the UI already prevents it.
  const targets = useMemo(
    () =>
      enabledShops.flatMap((shop) => {
        const dest = destinations.find((d) => d.shop === shop);
        const themeIds = targetThemes[shop] ?? [];
        return themeIds
          .filter((themeId) => !(dest?.isSource && themeId === sourceThemeId))
          .map((themeId) => {
            const theme = dest?.themes.find((t) => t.id === themeId);
            return {
              key: `${shop}::${themeId}`,
              shop,
              name: dest ? shopLabel(dest) : shop,
              isSource: Boolean(dest?.isSource),
              themeId,
              themeName: theme?.name ?? "",
              role: theme?.role ?? "",
            };
          });
      }),
    [enabledShops, targetThemes, destinations, sourceThemeId],
  );

  // "🇦🇺 or 🇺🇸 or 🇪🇺" - the flags of the stores you can copy into, so the
  // heading names the choice rather than describing it. Deduped, since the source
  // store now appears in the list too.
  const destinationFlags = [
    ...new Set(destinations.map((d) => d.flag).filter(Boolean)),
  ].join(" or ");

  // "🇬🇧 🇪🇺 🇺🇸" - the stores actually selected, for wording the media choices
  // in terms of where the files land rather than "the destination store".
  const targetFlagList = [
    ...new Set(
      targets
        .map((t) => destinations.find((d) => d.shop === t.shop)?.flag)
        .filter(Boolean),
    ),
  ].join(" ");

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
        sourceShop,
        sourceThemeId,
        filenames: JSON.stringify(selected),
        targets: JSON.stringify(
          targets.map(({ key, shop, themeId, name, themeName, role, isSource }) => ({
            key,
            shop,
            themeId,
            name,
            themeName,
            role,
            isSource,
          })),
        ),
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
        targets.map((t) => [t.key, { state: "COPYING", result: null }]),
      ),
    );

    // A failed target still has to render as one, not vanish.
    const failure = (target, message) => ({
      key: target.key,
      targetShop: target.shop,
      targetThemeId: target.themeId,
      targetThemeName: target.themeName,
      fileCount: selected.length,
      successCount: 0,
      status: "FAILED",
      files: [],
      media: [],
      error: message,
    });

    const post = async (target) => {
      const body = new FormData();
      body.set("intent", "copy");
      body.set("batchId", batchId);
      body.set("sourceShop", sourceShop);
      body.set("sourceThemeId", sourceThemeId);
      body.set("filenames", JSON.stringify(selected));
      body.set(
        "target",
        JSON.stringify({ shop: target.shop, themeId: target.themeId }),
      );
      body.set("copyMedia", String(copyMedia));
      body.set("overwriteMedia", String(overwriteMedia));

      try {
        // /api/template-copy is a resource route, so it answers with JSON. App
        // Bridge patches fetch to attach the session token, which is what
        // authenticate.admin uses to resolve the shop.
        const res = await fetch(COPY_ENDPOINT, { method: "POST", body });

        // Never assume JSON: an auth redirect or a crash answers with HTML, and
        // res.json() would throw the useless "Unexpected token '<'".
        const raw = await res.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(
            res.ok
              ? "The server didn't return JSON. Reload the page and try again."
              : `Request failed (HTTP ${res.status})`,
          );
        }

        const result = data.result ? { ...data.result, key: target.key } : null;

        setCopyProgress((prev) => ({
          ...prev,
          [target.key]: {
            state: result?.status === "SUCCESS" ? "DONE" : "FAILED",
            result:
              result ??
              failure(
                target,
                data.error ?? `Request failed (HTTP ${res.status})`,
              ),
          },
        }));
      } catch (err) {
        setCopyProgress((prev) => ({
          ...prev,
          [target.key]: {
            state: "FAILED",
            result: failure(target, err?.message ?? String(err)),
          },
        }));
      }
    };

    await Promise.all(targets.map(post));

    // Every region has reported; pull the history back in one go.
    historyFetcher.submit(
      { intent: "history" },
      { method: "post", action: COPY_ENDPOINT },
    );
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
  // Section/theme-block files the destination themes are missing. These are
  // copied automatically - without them Shopify rejects the template outright.
  const dependenciesFound =
    review?.some((c) => c.dependenciesToCopy?.length > 0) ?? false;
  // Media the template references that isn't in the source store's Files.
  const brokenSourceMedia = dedupeMedia(
    (review ?? []).flatMap((c) => c.mediaMissingOnSource ?? []),
  );

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
            <ResultsBanner results={results} shopDomainLabel={shopDomainLabel} />
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
                {sourceTheme && (
                  <InlineStack gap="150" blockAlign="center">
                    <Badge>{themeNumericId(sourceTheme.id)}</Badge>
                    {roleBadge(sourceTheme.role)}
                  </InlineStack>
                )}
              </InlineStack>

              {/* Which store to copy FROM. Any installed store, not just the one
                  the app is open in. */}
              {stores.length > 1 && (
                <BlockStack gap="150">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Source store
                  </Text>
                  <InlineStack gap="200" wrap>
                    {stores.map((s) => (
                      <Button
                        key={s.shop}
                        pressed={s.shop === sourceShop}
                        disabled={busy || loadingTemplates || !s.reachable}
                        onClick={() => changeSourceStore(s.shop)}
                      >
                        {shopLabel(s)}
                      </Button>
                    ))}
                  </InlineStack>
                </BlockStack>
              )}

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
                  Pick the stores to copy into, and one or more themes on each. You
                  can copy back into this same store on a different theme. Themes
                  are listed most recently edited first.
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
                const chosenIds = targetThemes[dest.shop] ?? [];
                // Same store: the theme you're copying FROM can't be a target.
                const availableThemes = dest.isSource
                  ? dest.themes.filter((t) => t.id !== sourceThemeId)
                  : dest.themes;

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
                          label={
                            <InlineStack gap="150" blockAlign="center">
                              <Text as="span">{shopLabel(dest)}</Text>
                              {dest.isSource && <Badge>This store</Badge>}
                            </InlineStack>
                          }
                          helpText={dest.shop}
                          checked={enabled}
                          disabled={!dest.reachable || busy}
                          onChange={() => toggleShop(dest.shop)}
                        />
                      </BlockStack>

                      {enabled && dest.reachable ? (
                        <MultiThemePicker
                          label={`Destination themes on ${dest.name}`}
                          themes={availableThemes}
                          selectedIds={chosenIds}
                          onToggle={(themeId) =>
                            toggleTargetTheme(dest.shop, themeId)
                          }
                          disabled={busy}
                          hint={
                            dest.isSource
                              ? "The source theme is hidden - you can't copy a theme onto itself."
                              : undefined
                          }
                        />
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
                  {`Copy ${selected.length} template${selected.length === 1 ? "" : "s"} to ${targets.length} theme${targets.length === 1 ? "" : "s"}`}
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
              shopDomainLabel={shopDomainLabel}
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
            ? `Copying to ${targets.length} theme${targets.length === 1 ? "" : "s"}...`
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
                  content: `Yes, copy to ${targets.length} theme${targets.length === 1 ? "" : "s"}`,
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
                      <Text as="p" variant="bodySm" key={c.key ?? c.shop}>
                        <Text as="span" fontWeight="semibold">
                          {shopDomainLabel(c.shop)}
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
                  <TargetDiff key={c.key ?? c.shop} check={c} targets={targets} />
                ))}

              {dependenciesFound && (
                <Banner tone="info" title="Section and block files will be copied too">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm">
                      These templates use sections and blocks that the destination
                      theme doesn't have yet. Shopify won't accept a template whose
                      blocks are missing, so those files are copied first. Files
                      the destination already has are left exactly as they are.
                    </Text>
                    {(review ?? [])
                      .filter((c) => c.dependenciesToCopy?.length > 0)
                      .map((c) => (
                        <Text as="p" variant="bodySm" key={c.key ?? c.shop}>
                          <Text as="span" fontWeight="semibold">
                            {`${shopDomainLabel(c.shop)}${c.themeName ? ` (${c.themeName})` : ""}`}
                          </Text>
                          {`: ${c.dependenciesToCopy.join(", ")}`}
                        </Text>
                      ))}
                  </BlockStack>
                </Banner>
              )}

              {brokenSourceMedia.length > 0 && (
                <Banner tone="warning" title="Some images are already missing on the source store">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm">
                      {`These templates point at ${mediaNoun(brokenSourceMedia)} that ${brokenSourceMedia.length === 1 ? "isn't" : "aren't"} in ${shopLabel(source)}'s Files any more, so ${brokenSourceMedia.length === 1 ? "it's" : "they're"} already broken there. Copying won't make this worse, but the same gap will exist on the destination.`}
                    </Text>
                    <MediaList refs={brokenSourceMedia} maxHeight="120px" />
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>
          </Modal.Section>
        ) : currentStep.id === "media" ? (
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p">
                {`These templates use ${mediaNoun(mediaReferenced)} from ${shopLabel(source)}'s Files. If the images aren't on the other store too, the copied page shows blank spaces where they should be - so they're copied across using the same filenames.`}
              </Text>

              <Checkbox
                label={`Copy these images and videos to ${targetFlagList || "the destination stores"}`}
                helpText={
                  mediaToCreate.length > 0
                    ? `${mediaNoun(mediaToCreate)} not there yet.`
                    : "Every file is already on those stores."
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
                      {`${mediaNoun(mediaConflicts)} already there with the same filename`}
                    </Text>
                    <ChoiceList
                      title="What should happen to those?"
                      titleHidden
                      choices={[
                        {
                          label: `Keep the file that's already on ${targetFlagList || "the destination stores"}`,
                          value: "keep",
                          helpText:
                            "Nothing is uploaded. The copied page uses the image already on that store, and nothing else on that store changes.",
                        },
                        {
                          label: `Replace it with the file from ${source.flag || shopLabel(source)}`,
                          value: "overwrite",
                          helpText:
                            "Uploads over the top of the existing image. Every other page on that store using this image changes too, and this can't be undone.",
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
                    {`${mediaNoun(mediaToCreate)} will be uploaded`}
                  </Text>
                  <MediaList refs={mediaToCreate} maxHeight="160px" />
                  {mediaToCreate.some((r) => r.kind === "VIDEO") && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Videos have to be downloaded and re-uploaded one at a time, so a
                      copy with videos takes longer. Anything over 250 MB is
                      skipped and reported.
                    </Text>
                  )}
                </BlockStack>
              )}

              {!copyMedia && mediaToCreate.length > 0 && (
                <Banner tone="warning" title="Media will be missing">
                  <Text as="p" variant="bodySm">
                    {`${mediaNoun(mediaToCreate)} used by these templates ${mediaToCreate.length === 1 ? "isn't" : "aren't"} on the other store. Those spots will be blank until someone uploads them by hand with the same filename.`}
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
                  const check = (review ?? []).find((c) => c.key === t.key);
                  return (
                    <List.Item key={t.key}>
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <Text as="span">
                          {`${t.name} - ${t.themeName}: `}
                          <Text as="span" fontWeight="semibold">
                            {check
                              ? `${check.changedCount} overwritten, ${check.newCount} created, ${check.identicalCount} unchanged`
                              : "not checked"}
                          </Text>
                        </Text>
                        <Badge>{themeNumericId(t.themeId)}</Badge>
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
  const store = `${targets} destination theme${targets === 1 ? "" : "s"}`;

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
            {`${doneCount} of ${targets.length} theme${targets.length === 1 ? "" : "s"} done`}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {`${percentComplete}%`}
          </Text>
        </InlineStack>
        <ProgressBar progress={percentComplete} size="small" tone="primary" />
      </BlockStack>

      {targets.map((target) => {
        const entry = progress?.[target.key];
        const result = entry?.result;

        return (
          <InlineStack
            key={target.key}
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
                <InlineStack gap="150" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {target.themeName}
                  </Text>
                  <Badge>{themeNumericId(target.themeId)}</Badge>
                </InlineStack>
              </BlockStack>
            </InlineStack>

            <InlineStack gap="300" blockAlign="center">
              <Text
                as="span"
                variant="bodySm"
                tone={result?.error ? "critical" : "subdued"}
              >
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
              {/* Open this region as soon as it lands, without waiting for the
                  other regions to finish. */}
              {entry?.state === "DONE" && (
                <Button
                  size="micro"
                  icon={PaintBrushFlatIcon}
                  url={themeEditorUrl(
                    target.shop,
                    target.themeId,
                    result?.files?.find((f) => f.status === "SUCCESS")?.filename,
                  )}
                  target="_blank"
                >
                  Customize
                </Button>
              )}
            </InlineStack>
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
  const target = targets.find((t) => t.key === check.key) ??
    targets.find((t) => t.shop === check.shop);

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
          {target?.themeId && <Badge>{themeNumericId(target.themeId)}</Badge>}
          {target?.role === "MAIN" && <Badge tone="critical">Live theme</Badge>}
          {/* Look at what you're about to overwrite, before you overwrite it. */}
          {target && (
            <Link
              url={themeEditorUrl(
                check.shop,
                target.themeId,
                check.files[0]?.filename,
              )}
              target="_blank"
            >
              View current
            </Link>
          )}
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
function ResultsBanner({ results, shopDomainLabel }) {
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
                  {shopDomainLabel(r.targetShop)}
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

              {/* Straight into that store's theme editor, on the template that
                  just landed - one link per template, for every region. */}
              {r.files.filter((f) => f.status === "SUCCESS").length > 0 && (
                <Box paddingInlineStart="300">
                  <InlineStack gap="150" wrap>
                    {r.files
                      .filter((f) => f.status === "SUCCESS")
                      .map((f) => (
                        <Button
                          key={f.filename}
                          size="micro"
                          icon={PaintBrushFlatIcon}
                          url={themeEditorUrl(
                            r.targetShop,
                            r.targetThemeId,
                            f.filename,
                          )}
                          target="_blank"
                        >
                          {`Customize ${f.filename.replace(/^templates\//, "")}`}
                        </Button>
                      ))}
                    <Button
                      size="micro"
                      variant="tertiary"
                      icon={ViewIcon}
                      url={storefrontPreviewUrl(r.targetShop, r.targetThemeId)}
                      target="_blank"
                    >
                      Preview store
                    </Button>
                  </InlineStack>
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

                  {/* The destination store renamed a file to keep it unique, so
                      the templates were rewritten to point at the new name. */}
                  {r.mediaRenames?.length > 0 && (
                    <Box paddingBlockStart="100">
                      <Text as="p" variant="bodySm">
                        {`${r.mediaRenames.length} file${r.mediaRenames.length === 1 ? " was" : "s were"} renamed by ${shopDomainLabel(r.targetShop)} to keep filenames unique. The copied templates were updated to use the new names:`}
                      </Text>
                      <List type="bullet">
                        {r.mediaRenames.map((m) => (
                          <List.Item key={`${m.kind}:${m.from}`}>
                            <Text as="span" variant="bodySm">
                              {`${m.from} -> ${m.to}`}
                            </Text>
                          </List.Item>
                        ))}
                      </List>
                    </Box>
                  )}

                  {media.some((m) => m.unverified) && (
                    <Box paddingBlockStart="100">
                      <Text as="p" variant="bodySm" tone="caution">
                        {`${media.filter((m) => m.unverified).length} file(s) were still processing, so their final filenames couldn't be confirmed. If an image renders broken, re-run the copy.`}
                      </Text>
                    </Box>
                  )}
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
function HistoryCard({ history, onRevert, reverting, reverts, shopDomainLabel }) {
  // Batches are collapsed by default - the history is a scannable timeline, and
  // the per-theme detail is there when you want it, not in your way when you
  // don't. Keyed by batchId so expanding one leaves the rest alone.
  const [openBatches, setOpenBatches] = useState({});
  const toggleBatch = (batchId) =>
    setOpenBatches((prev) => ({ ...prev, [batchId]: !prev[batchId] }));

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
                    ? `${shopDomainLabel(r.targetShop)} (${r.targetThemeName}): ${r.results.filter((x) => x.status === "RESTORED").length} restored, ${r.results.filter((x) => x.status === "DELETED").length} deleted`
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
          const open = Boolean(openBatches[batch.batchId]);

          return (
            <Box
              key={batch.batchId}
              padding="300"
              borderRadius="200"
              borderWidth="025"
              borderColor="border"
            >
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
                  {/* The summary row is the disclosure toggle: chevron at the far
                      left, meta to its right, revert pushed to the far end. */}
                  <button
                    type="button"
                    onClick={() => toggleBatch(batch.batchId)}
                    className="tc-batch-toggle"
                  >
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <Icon
                        source={open ? ChevronDownIcon : ChevronRightIcon}
                        tone="subdued"
                      />
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
                        {copiedAt(batch.createdAt)}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`${batch.targets.length} theme${batch.targets.length === 1 ? "" : "s"}`}
                      </Text>
                      {batch.copiedBy && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {`by ${batch.copiedBy}`}
                        </Text>
                      )}
                    </InlineStack>
                  </button>

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

                {/* Which templates this batch copied - aligned under the meta. */}
                <Box paddingInlineStart="600">
                  <Text as="p" variant="bodySm">
                    <Text as="span" tone="subdued">
                      {`From ${batch.sourceThemeName}: `}
                    </Text>
                    {batch.templates
                      .map((f) => f.replace(/^templates\//, ""))
                      .join(", ")}
                  </Text>
                </Box>

                <Collapsible
                  id={`batch-${batch.batchId}`}
                  open={open}
                  transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
                >
                  <BlockStack gap="300">
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
                          {`${shopDomainLabel(t.targetShop)} - ${t.targetThemeName}`}
                        </Text>
                        <Badge>{themeNumericId(t.targetThemeId)}</Badge>
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

                      {/* Preview links for this region, one per template that
                          landed - the theme editor opens on that template. */}
                      {t.files.filter((f) => f.status === "SUCCESS").length > 0 && (
                        <Box paddingBlockStart="100">
                          <InlineStack gap="150" wrap>
                            {t.files
                              .filter((f) => f.status === "SUCCESS")
                              .map((f) => (
                                <Button
                                  key={f.filename}
                                  size="micro"
                                  icon={PaintBrushFlatIcon}
                                  url={themeEditorUrl(
                                    t.targetShop,
                                    t.targetThemeId,
                                    f.filename,
                                  )}
                                  target="_blank"
                                >
                                  {`Customize ${f.filename.replace(/^templates\//, "")}`}
                                </Button>
                              ))}
                            <Button
                              size="micro"
                              variant="tertiary"
                              icon={ViewIcon}
                              url={storefrontPreviewUrl(t.targetShop, t.targetThemeId)}
                              target="_blank"
                            >
                              Preview store
                            </Button>
                          </InlineStack>
                        </Box>
                      )}
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
                </Collapsible>
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
