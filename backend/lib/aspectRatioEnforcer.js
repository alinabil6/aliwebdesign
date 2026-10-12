import sharp from "sharp";

export const SUPPORTED_RATIOS = {
  "1:1": {
    w: 1,
    h: 1,
    ratio: 1.0,
    name: "1:1 Square",
    orientation: "square",
    desc: "1:1 Square format (equal width and height, balanced 1:1 square canvas)",
  },
  "9:16": {
    w: 9,
    h: 16,
    ratio: 9 / 16,
    name: "9:16 Vertical Story",
    orientation: "tall vertical portrait",
    desc: "9:16 Vertical Story format (strictly vertical portrait orientation, 9 units wide by 16 units tall, significantly taller than it is wide)",
  },
  "3:4": {
    w: 3,
    h: 4,
    ratio: 3 / 4,
    name: "3:4 Portrait",
    orientation: "vertical portrait",
    desc: "3:4 Portrait format (vertical portrait orientation, 3 units wide by 4 units tall, taller than wide)",
  },
  "4:3": {
    w: 4,
    h: 3,
    ratio: 4 / 3,
    name: "4:3 Landscape",
    orientation: "horizontal landscape",
    desc: "4:3 Landscape format (horizontal landscape orientation, 4 units wide by 3 units tall, wider than tall)",
  },
  "16:9": {
    w: 16,
    h: 9,
    ratio: 16 / 9,
    name: "16:9 Widescreen",
    orientation: "wide horizontal landscape",
    desc: "16:9 Widescreen format (strictly horizontal panoramic landscape orientation, 16 units wide by 9 units tall, significantly wider than tall)",
  },
  "4:5": {
    w: 4,
    h: 5,
    ratio: 4 / 5,
    name: "4:5 Print Portrait",
    orientation: "vertical portrait",
    desc: "4:5 Print Portrait format (vertical portrait apparel print orientation, 4 units wide by 5 units tall, taller than wide)",
  },
};

/**
 * Clean & normalize aspect ratio string into a supported key ("1:1", "9:16", etc.).
 */
export function normalizeAspectRatio(raw) {
  if (!raw) return "1:1";
  const s = String(raw).trim().replace(/\s+/g, "");
  if (SUPPORTED_RATIOS[s]) return s;
  // If formatted like 9-16 or 9_16 or 9x16
  const alt = s.replace(/[-_x]/g, ":");
  if (SUPPORTED_RATIOS[alt]) return alt;
  return "1:1";
}

/**
 * Builds authoritative prompt directives for Gemini to respect the chosen design shape.
 * Always includes explicit instructions even for 1:1 square.
 */
export function buildAspectRatioDirective(rawRatio, { hasReferenceImage = false } = {}) {
  const ar = normalizeAspectRatio(rawRatio);
  const cfg = SUPPORTED_RATIOS[ar] || SUPPORTED_RATIOS["1:1"];

  const lines = [
    `Aspect Ratio & Canvas Geometry: Format canvas strictly to ${cfg.desc}.`,
    `Framing: Center and structure the entire merchandise artwork within this ${cfg.orientation} frame.`
  ];

  if (hasReferenceImage) {
    lines.push(
      `Canvas Re-Framing: Regardless of the original aspect ratio, shape, or dimensions of any attached reference image, you MUST re-compose, re-frame, and restructure the design to strictly output inside the requested ${ar} canvas format. Do NOT copy or preserve the bounding box or aspect ratio of the input image if it differs from ${ar}.`
    );
  }

  return lines.join(" ");
}

/**
 * Parse hex color string (e.g. "#FFFFFF", "#1E293B", "transparent") into a sharp background object.
 */
function parseBgColor(rawBg) {
  const bg = String(rawBg || "").trim().toLowerCase();
  if (bg === "transparent") {
    return { r: 0, g: 0, b: 0, alpha: 0 };
  }
  if (/^#?[0-9a-f]{6}$/.test(bg)) {
    const clean = bg.replace("#", "");
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
      alpha: 1,
    };
  }
  if (/^#?[0-9a-f]{3}$/.test(bg)) {
    const clean = bg.replace("#", "");
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
      alpha: 1,
    };
  }
  return null;
}

/**
 * Formats an image buffer to strictly adhere to the requested aspect ratio.
 * If the image already matches (within 3%), it is returned untouched.
 * Otherwise, pads/extends the canvas with matching background color to achieve
 * the exact target aspect ratio without stretching or distorting the artwork.
 */
export async function formatImageToAspectRatio(buffer, rawRatio, { bg_color = "" } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;

  const ar = normalizeAspectRatio(rawRatio);
  const cfg = SUPPORTED_RATIOS[ar];
  if (!cfg) return buffer;

  try {
    const image = sharp(buffer);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return buffer;

    const currentRatio = meta.width / meta.height;
    const targetRatio = cfg.ratio;

    // Tolerance check: if within 3% of target, consider it a match
    if (Math.abs(currentRatio - targetRatio) / targetRatio < 0.03) {
      return buffer;
    }

    // Determine background color
    let background = parseBgColor(bg_color);
    if (!background) {
      // Sample edge pixel from the generated image
      try {
        const { data } = await image.raw().toBuffer({ resolveWithObject: true });
        background = {
          r: data[0] ?? 0,
          g: data[1] ?? 0,
          b: data[2] ?? 0,
          alpha: data[3] !== undefined ? data[3] / 255 : 1,
        };
      } catch {
        background = { r: 0, g: 0, b: 0, alpha: 0 };
      }
    }

    let targetWidth = meta.width;
    let targetHeight = meta.height;
    let top = 0;
    let left = 0;

    if (currentRatio > targetRatio) {
      // Image is wider than target ratio -> expand height (e.g. 1:1 -> 9:16)
      targetHeight = Math.round(meta.width / targetRatio);
      top = Math.round((targetHeight - meta.height) / 2);
    } else {
      // Image is taller than target ratio -> expand width (e.g. 1:1 -> 16:9)
      targetWidth = Math.round(meta.height * targetRatio);
      left = Math.round((targetWidth - meta.width) / 2);
    }

    const formattedBuffer = await sharp({
      create: {
        width: Math.max(1, targetWidth),
        height: Math.max(1, targetHeight),
        channels: 4,
        background,
      },
    })
      .composite([{ input: buffer, top, left }])
      .png({ compressionLevel: 6 })
      .toBuffer();

    return formattedBuffer;
  } catch (err) {
    console.warn("[aspectRatioEnforcer] Error formatting aspect ratio:", err.message);
    return buffer;
  }
}
