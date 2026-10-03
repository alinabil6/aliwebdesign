import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";

export const COMPOSITION_DIRECTIVE =
  "Harmonious 2D vector screen-print graphic maintaining centered apparel layout balance, crisp contours, and clean separation.";

export const OUTPUT_REQUIREMENTS =
  "Visual format: Flat 2D vector apparel illustration, centered, sharp clean contours, solid single-color backdrop, print-ready commercial merchandise asset. Zero t-shirt mockups, zero models, zero fabric creases, zero photorealism.";

export function buildPrompt({
  target_niche = "",
  variant = 0,
  style_directive = "",
  style_name = "",
  bg_color = ""
} = {}) {
  const bg = buildBackgroundBlock(bg_color);
  const niche = String(target_niche || "featured concept").trim();

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  const styleClause = style_directive
    ? `Artistic technique: ${style_name || "vector apparel"}. ${style_directive}.`
    : "Artistic technique: High-contrast commercial vector screen-print graphic with bold linework and flat saturated colors.";

  return [
    `Generate a full-color 2D vector t-shirt graphic illustration of ${niche}, matching the composition, layout structure, and silhouette framing of the attached reference design.`,
    `Focal subject: ${niche} rendered as the prominent central element, matching the scale, posture, and placement of the primary subject in the reference.`,
    `Composition: Apparel emblem layout replicating the attached reference architecture—centered hierarchy, matching frame geometry, balanced visual weight, and clean outer contours.`,
    `Typography: Recreate any lettering banners or text curves from the reference displaying "${niche}". Crisp, legible vector typography integrated directly into the graphic. If the reference design contains no text, render a pure illustration with zero letters, numbers, or words.`,
    styleClause,
    bgBlock,
    OUTPUT_REQUIREMENTS
  ].filter(Boolean).join("\n\n").trim();
}
