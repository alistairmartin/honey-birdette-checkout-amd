import { useEffect, useState } from "preact/hooks";

// The Polaris <s-image> has no "natural size" mode. It always renders inside
// an aspect ratio frame that defaults to 1/1, so a wide banner gets large empty
// bands above and below it. These helpers work out the real ratio of an image
// so the frame can match it.

export type AspectRatio = `${number}/${number}` | `${number}`;

const cache = new Map<string, AspectRatio | null>();

/** Accepts "1254/192", "1254:192", "1254x192" or "6.5". Returns a CSS ratio or "". */
export function parseAspectRatio(value: unknown): AspectRatio | "" {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  const pair = text.match(/^(\d+(?:\.\d+)?)\s*[/:x]\s*(\d+(?:\.\d+)?)$/i);
  if (pair) {
    return Number(pair[1]) > 0 && Number(pair[2]) > 0 ? (`${pair[1]}/${pair[2]}` as AspectRatio) : "";
  }
  const single = Number(text);
  return Number.isFinite(single) && single > 0 ? (String(single) as AspectRatio) : "";
}

function readDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.length;
  const ascii = (start: number, count: number) =>
    String.fromCharCode(...bytes.subarray(start, start + count));

  // PNG
  if (length >= 24 && view.getUint32(0) === 0x89504e47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF
  if (length >= 10 && ascii(0, 3) === "GIF") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // WebP
  if (length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
  }

  // JPEG: walk the segments until a start-of-frame marker.
  if (length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
  }

  return null;
}

async function detectAspectRatio(url: string): Promise<AspectRatio | null> {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Image banner: image request failed with status ${response.status}`, url);
    return null;
  }
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let size = readDimensions(bytes);
  if (!size && typeof createImageBitmap === "function") {
    // Formats the header parser does not cover (for example AVIF).
    const bitmap = await createImageBitmap(blob);
    size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
  }

  if (!size || !(size.width > 0) || !(size.height > 0)) {
    console.error(
      `Image banner: could not read dimensions from ${bytes.length} bytes of type "${blob.type}"`,
      url,
    );
    return null;
  }

  return `${size.width}/${size.height}` as AspectRatio;
}

/**
 * Returns the aspect ratio to use for an image.
 * - `undefined` while it is still being worked out (render nothing yet)
 * - a CSS ratio string once known
 * - `null` if it could not be detected (the caller should fall back)
 * A non-empty `override` wins and skips detection.
 */
export function useImageAspectRatio(
  url: string,
  override: AspectRatio | "" = "",
): AspectRatio | null | undefined {
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!url || override || cache.has(url)) return;
    let cancelled = false;
    detectAspectRatio(url)
      .catch((error) => {
        console.error("Image banner: could not read image dimensions", error);
        return null;
      })
      .then((ratio) => {
        cache.set(url, ratio);
        if (!cancelled) setVersion((version) => version + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [url, override]);

  if (override) return override;
  if (!url) return null;
  return cache.has(url) ? cache.get(url) : undefined;
}
