import { useEffect, useMemo, useRef, useState } from "react";
import { Text, Spinner, BlockStack, InlineStack, Box } from "@shopify/polaris";

// Blue sequential ramp (light->dark), from the validated data-viz palette. Index
// 0 is the lightest "near zero" step; higher buckets = more orders.
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const ZERO_FILL = "var(--p-color-bg-surface-secondary, #ebebeb)";
const STROKE = "var(--p-color-bg-surface, #ffffff)";
// Red (palette slot 8) marks the source store - the one visitors were redirected
// away from. A different hue, not a step of the blue ramp, so it never reads as
// "lots of orders".
const SOURCE_FILL = "#e34948";

function countryName(code, fallback) {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || fallback;
  } catch {
    return fallback;
  }
}

// Build ascending bucket thresholds so colour steps track magnitude. Uses a
// simple geometric split of [1..max] into RAMP.length-1 bands, which keeps a
// long tail of small countries readable against a few big ones.
function makeBuckets(max) {
  const bands = RAMP.length - 1; // exclude the zero step
  if (max <= bands) {
    return Array.from({ length: bands }, (_, i) => i + 1);
  }
  const ratio = Math.pow(max, 1 / bands);
  const t = [];
  for (let i = 1; i <= bands; i += 1) {
    t.push(Math.round(Math.pow(ratio, i)));
  }
  for (let i = 1; i < t.length; i += 1) {
    if (t[i] <= t[i - 1]) t[i] = t[i - 1] + 1;
  }
  return t;
}

function bucketIndex(count, buckets) {
  if (!count) return 0;
  for (let i = 0; i < buckets.length; i += 1) {
    if (count <= buckets[i]) return i + 1;
  }
  return RAMP.length - 1;
}

// `counts`   { ISO2(uppercase): number } - detected-country order counts.
// `sourceIso` countries painted red (the store visitors were redirected from).
// `overlays` [{ iso: [...], color, label }] - catchment groups drawn as coloured
//            OUTLINES so the order-count fill underneath stays readable.
export default function WorldChoropleth({
  counts,
  valueLabel = "orders",
  sourceIso = [],
  sourceLabel = "Source store",
  overlays = [],
}) {
  const [map, setMap] = useState(null);
  const [error, setError] = useState(null);
  const [hover, setHover] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    let alive = true;
    // Versioned filename: the browser caches this aggressively, so a change to
    // the geometry needs a new URL or you keep getting the old shapes. Bump the
    // suffix (and rename the file in public/) whenever the map data changes.
    fetch("/world-map-v2.json")
      .then((r) => {
        if (!r.ok) throw new Error(`map load failed (${r.status})`);
        return r.json();
      })
      .then((d) => alive && setMap(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  const byId = useMemo(() => {
    const m = {};
    for (const [k, v] of Object.entries(counts || {})) {
      if (/^[A-Za-z]{2}$/.test(k)) m[k.toLowerCase()] = v;
    }
    return m;
  }, [counts]);

  const max = useMemo(() => Math.max(0, ...Object.values(byId)), [byId]);
  const buckets = useMemo(() => makeBuckets(max), [max]);

  const sourceSet = useMemo(
    () => new Set((sourceIso || []).map((c) => String(c).toLowerCase())),
    [sourceIso],
  );

  // iso -> overlay. Earlier overlays win, so the primary group is listed first.
  const overlayBy = useMemo(() => {
    const m = new Map();
    for (const o of overlays || []) {
      for (const iso of o.iso || []) {
        const k = String(iso).toLowerCase();
        if (!m.has(k)) m.set(k, o);
      }
    }
    return m;
  }, [overlays]);

  if (error) {
    return (
      <Box padding="400">
        <Text as="p" tone="critical" variant="bodySm">
          Couldn&apos;t load the world map ({error}). The tables below still have
          the full data.
        </Text>
      </Box>
    );
  }

  if (!map) {
    return (
      <Box padding="600">
        <InlineStack align="center" gap="200" blockAlign="center">
          <Spinner size="small" accessibilityLabel="Loading map" />
          <Text as="span" tone="subdued" variant="bodySm">Loading map…</Text>
        </InlineStack>
      </Box>
    );
  }

  // Draw order: plain (0) -> outlined catchment (1) -> source fill (2), so a
  // neighbour's fill never overdraws an outline.
  function rank(loc) {
    if (sourceSet.has(loc.id)) return 2;
    if (overlayBy.has(loc.id)) return 1;
    return 0;
  }

  function onMove(e, loc) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({
      name: countryName(loc.id.toUpperCase(), loc.name),
      count: byId[loc.id] || 0,
      isSource: sourceSet.has(loc.id),
      overlay: overlayBy.get(loc.id) || null,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }

  const legend = [{ color: ZERO_FILL, label: "0" }];
  let lo = 1;
  buckets.forEach((hi, i) => {
    legend.push({ color: RAMP[i + 1], label: hi === lo ? `${lo}` : `${lo}–${hi}` });
    lo = hi + 1;
  });
  if (max > buckets[buckets.length - 1]) {
    legend[legend.length - 1].label = `${buckets[buckets.length - 2] + 1}+`;
  }
  if (sourceSet.size) legend.push({ color: SOURCE_FILL, label: sourceLabel });
  for (const o of overlays || []) {
    legend.push({ color: o.color, label: o.label, outline: true });
  }

  return (
    <BlockStack gap="300">
      <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
        <svg
          viewBox={map.viewBox}
          role="img"
          aria-label="World map of detected countries by order volume"
          style={{ width: "100%", height: "auto", display: "block" }}
          onMouseLeave={() => setHover(null)}
        >
          {[...map.locations]
            .sort((a, b) => rank(a) - rank(b))
            .map((loc) => {
              const count = byId[loc.id] || 0;
              const isSource = sourceSet.has(loc.id);
              const overlay = overlayBy.get(loc.id);
              const fill = isSource
                ? SOURCE_FILL
                : count
                  ? RAMP[bucketIndex(count, buckets)]
                  : ZERO_FILL;
              const outlined = !isSource && overlay;
              return (
                <path
                  key={loc.id}
                  d={loc.path}
                  fill={fill}
                  stroke={outlined ? overlay.color : STROKE}
                  strokeWidth={outlined ? 1.4 : 0.5}
                  onMouseMove={(e) => onMove(e, loc)}
                  style={{
                    cursor: count || isSource || overlay ? "pointer" : "default",
                  }}
                />
              );
            })}
        </svg>

        {hover && (
          <div
            style={{
              position: "absolute",
              left: Math.min(hover.x + 12, (containerRef.current?.clientWidth || 0) - 180),
              top: hover.y + 12,
              pointerEvents: "none",
              background: "var(--p-color-bg-surface, #fff)",
              color: "var(--p-color-text, #1a1a1a)",
              border: "1px solid var(--p-color-border, #ccc)",
              borderRadius: 8,
              padding: "6px 10px",
              boxShadow: "var(--p-shadow-200, 0 2px 6px rgba(0,0,0,.15))",
              fontSize: 12,
              whiteSpace: "nowrap",
              zIndex: 5,
            }}
          >
            <strong>{hover.name}</strong>
            <br />
            {hover.count.toLocaleString()} {valueLabel}
            {hover.isSource && (
              <>
                <br />
                <span style={{ color: SOURCE_FILL, fontWeight: 600 }}>{sourceLabel}</span>
              </>
            )}
            {hover.overlay && (
              <>
                <br />
                <span style={{ color: hover.overlay.color, fontWeight: 600 }}>
                  {hover.overlay.label}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <InlineStack gap="300" align="center" wrap>
        {legend.map((b) => (
          <InlineStack key={b.label} gap="100" blockAlign="center">
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                background: b.outline ? "transparent" : b.color,
                border: b.outline
                  ? `2px solid ${b.color}`
                  : "1px solid var(--p-color-border, #ccc)",
                display: "inline-block",
                flex: "0 0 auto",
              }}
            />
            <Text as="span" variant="bodySm" tone="subdued">{b.label}</Text>
          </InlineStack>
        ))}
      </InlineStack>
    </BlockStack>
  );
}
