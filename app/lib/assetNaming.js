// Filename rules and limits for the asset uploader. Deliberately not a .server
// module: the page previews the final names as you type, and the action rebuilds
// them server-side, so both sides have to agree exactly.

// Shopify caps a single fileCreate call at 50 assets, and staged uploads the
// same way, so this is the ceiling rather than a comfort margin.
export const MAX_FILES = 50;

// Shopify rejects filenames with anything exotic in them, so everything outside
// this set collapses to a hyphen. The extension is handled separately.
export const sanitiseSegment = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

export const splitExtension = (filename) => {
  const match = /^(.*?)(\.[a-zA-Z0-9]+)?$/.exec(String(filename ?? ""));
  return { base: match?.[1] ?? "", ext: (match?.[2] ?? "").toLowerCase() };
};

/** Builds the final filename from the user's prefix/date settings. */
export const buildFilename = ({
  originalName,
  prefix = "",
  dateStamp = "",
  datePosition = "suffix",
  index = null,
  keepOriginalName = true,
}) => {
  const { base, ext } = splitExtension(originalName);
  const parts = [];

  if (prefix) parts.push(sanitiseSegment(prefix));
  if (dateStamp && datePosition === "prefix") parts.push(sanitiseSegment(dateStamp));
  if (keepOriginalName && base) parts.push(sanitiseSegment(base));
  if (index !== null) parts.push(String(index).padStart(2, "0"));
  if (dateStamp && datePosition === "suffix") parts.push(sanitiseSegment(dateStamp));

  const stem = parts.filter(Boolean).join("-") || "asset";
  return `${stem}${ext}`;
};
