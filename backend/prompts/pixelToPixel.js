import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";

export function buildPrompt({
  bg_color = "",
  style_directive = "",
  style_name = "",
  variant = 0
} = {}) {
  const bg = buildBackgroundBlock(bg_color);

  const styleClause = style_directive
    ? `Artistic styling: ${style_name || "vector redraw"}. ${style_directive} (Maintain exact subject and layout fidelity while applying this rendering technique).`
    : "Artistic styling: High-definition 2D vector apparel illustration with razor-sharp contours, smooth curves, and clean solid color fills.";

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  return [
    "Generate an ultra-high-definition 2D vector t-shirt graphic redraw of the attached reference artwork.",
    "Fidelity & Composition: Exact 1:1 reconstruction of the attached design—retaining identical composition, subject placement, proportions, silhouette contours, and overall visual balance.",
    "Resolution & Quality: Transform the reference into pristine print-ready vector artwork with razor-sharp edges, smooth curves, rich saturated colors, and zero pixelation, blur, or compression artifacts.",
    "Typography: Re-render any existing text from the reference with crisp, perfectly aligned vector typography. Do not output style names, prompt words, or metadata as text. If the reference is graphic-only, output zero text.",
    styleClause,
    bgBlock,
    "Visual format: Flat 2D vector merchandise illustration, centered, sharp clean contours, solid single-color backdrop, print-ready commercial apparel asset. Zero t-shirt mockups, zero models, zero fabric creases, zero photorealism."
  ].filter(Boolean).join("\n\n").trim();
}