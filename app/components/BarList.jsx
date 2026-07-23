import { BlockStack, InlineStack, Text } from "@shopify/polaris";

// A dependency-free horizontal bar list for a single measure (magnitude).
// One hue (blue) from the validated palette - a single series needs no legend.
const BAR = "#2a78d6";
const TRACK = "var(--p-color-bg-surface-secondary, #ebebeb)";

// `data`: [{ label, value }], already sorted. `total` for the share text.
export default function BarList({ data, total, valueSuffix = "" }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <BlockStack gap="200">
      {data.map((d) => {
        const w = `${Math.max(2, (d.value / max) * 100)}%`;
        const share = total ? `${((d.value / total) * 100).toFixed(1)}%` : "";
        return (
          <BlockStack gap="050" key={d.label}>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="bodySm">{d.label}</Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {d.value.toLocaleString()}{valueSuffix}
                {share ? ` · ${share}` : ""}
              </Text>
            </InlineStack>
            <div
              style={{
                background: TRACK,
                borderRadius: 4,
                overflow: "hidden",
                height: 10,
                width: "100%",
              }}
            >
              <div
                style={{
                  background: BAR,
                  height: "100%",
                  width: w,
                  borderRadius: 4,
                }}
              />
            </div>
          </BlockStack>
        );
      })}
    </BlockStack>
  );
}
