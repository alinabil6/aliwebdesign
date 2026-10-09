import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";
import { UNIVERSAL_FOOTER } from "./textToImage.js";

export function buildPrompt({
  bg_color = "#000000",
  style_directive = "",
  style_name = "",
  variant = 0,
  aspectRatio = "1:1"
} = {}) {
  const bg = buildBackgroundBlock(bg_color);
  const ar = String(aspectRatio || "1:1").trim();
  const arDirective = ar && ar !== "1:1" ? `Aspect ratio: ${ar} (--ar ${ar}). Design canvas structured strictly to ${ar} aspect ratio format.` : "";

  const styleClause = style_directive
    ? `Artistic technique: ${style_name || "vector apparel"}. ${style_directive}.`
    : "Artistic technique: High-contrast commercial vector screen-print graphic with bold linework and flat saturated colors.";

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  return [
    "You are an elite print-on-demand graphic designer. Redraw the core concept of the provided reference artwork into a fresh, commercially viable 2D apparel graphic.",
    "Preserve the original subject, message, humor, recognizable elements, and visual identity while substantially reworking the composition, element placement, proportions, and visual hierarchy to create a genuinely new design rather than a near-copy.",
    "Preserve all existing wording exactly when text is present. Do not invent, replace, rewrite, correct, or remove text. If the reference contains no text, do not add any words, letters, numbers, or typography.",
    "Use clean, bold shapes, crisp contours, clear visual hierarchy, and strong contrast. Preserve the original color palette's visual character unless the selected artistic style calls for a compatible rendering treatment.",
    "Do not force the artwork into a logo, badge, emblem, shield, banner, or circular layout. Follow the reference's actual concept and create a composition suited to that specific design.",
    styleClause,
    arDirective,
    bgBlock,
    UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}