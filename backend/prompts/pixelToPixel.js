import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";
import { UNIVERSAL_FOOTER } from "./textToImage.js";

export function buildPrompt({
  bg_color = "",
  style_directive = "",
  style_name = "",
  variant = 0,
  aspectRatio = "1:1"
} = {}) {
  const bg = buildBackgroundBlock(bg_color);
  const ar = String(aspectRatio || "1:1").trim();
  const arDirective = ar && ar !== "1:1" ? `Aspect ratio: ${ar} (--ar ${ar}). Design canvas structured strictly to ${ar} aspect ratio format.` : "";

  const styleClause = style_directive
    ? `Artistic technique: ${style_name || "vector redraw"}. ${style_directive} (Maintain exact subject and layout fidelity while applying this rendering technique).`
    : "Artistic technique: High-definition 2D vector apparel illustration with razor-sharp contours, smooth curves, and clean solid color fills.";

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  return [
    "Generate an ultra-high-definition 2D vector t-shirt graphic redraw directly from the attached reference artwork.",
    "Visual Subject: Exact 1:1 reconstruction of the attached artwork—retaining identical visual elements, subject placement, proportions, silhouette contours, and overall balance.",
    "Quality & Resolution: Render pristine print-ready vector artwork with razor-sharp edges, smooth curves, rich saturated colors, and zero pixelation, blur, or compression artifacts.",
    "Typography: Re-render any existing text from the reference with crisp, perfectly aligned vector typography. Do not output style names, prompt words, or metadata as text. If the reference is graphic-only, output strictly zero letters, numbers, words, or text.",
    styleClause,
    arDirective,
    bgBlock,
    UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}