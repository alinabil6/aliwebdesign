import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";

export function buildPrompt({
  bg_color = "#000000",
  style_directive = "",
  style_name = "",
  variant = 0
} = {}) {
  const bg = buildBackgroundBlock(bg_color);

  const styleClause = style_directive
    ? `Artistic style: ${style_name || "selected style"}. ${style_directive}.`
    : "Artistic style: Crisp commercial vector screen-print illustration with bold line art and vibrant solid colors.";

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  return [
    "Create a modernized 2D vector t-shirt graphic illustration redrawing and reimagining the core concept of the attached image into a fresh apparel design.",
    "Subject & Theme: Reconstruct the central characters, motifs, humor, and recognizable subject matter of the attached reference into a dynamic new apparel composition.",
    "Composition & Balance: Fresh restructured visual hierarchy with bold silhouette, rebalanced elements, high-contrast separation, and clean outer contours.",
    "Typography: If the reference contains text, redesign the existing wording with sharp, legible vector lettering integrated into the graphic. Do not invent unrequested words or slogans. If the reference has no text, render 100% graphic-only with zero words, letters, or numbers.",
    styleClause,
    bgBlock,
    "Visual format: Flat 2D vector merchandise illustration, centered, sharp clean contours, solid single-color backdrop, print-ready commercial apparel asset. Zero t-shirt mockups, zero models, zero fabric creases, zero photorealism."
  ].filter(Boolean).join("\n\n").trim();
}