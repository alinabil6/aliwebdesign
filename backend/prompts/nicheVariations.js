import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";
import { UNIVERSAL_FOOTER } from "./textToImage.js";

export { UNIVERSAL_FOOTER };
export const OUTPUT_REQUIREMENTS = UNIVERSAL_FOOTER;

export function buildPrompt({
  target_niche = "",
  variant = 0,
  style_directive = "",
  style_name = "",
  bg_color = "",
  aspectRatio = "1:1"
} = {}) {
  const bg = buildBackgroundBlock(bg_color);
  const niche = String(target_niche || "featured concept").trim();
  const ar = String(aspectRatio || "1:1").trim();
  const arDirective = ar && ar !== "1:1" ? `Aspect ratio: ${ar} (--ar ${ar}). Design canvas structured strictly to ${ar} aspect ratio format.` : "";

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  const styleClause = style_directive
    ? `Artistic technique: ${style_name || "vector apparel"}. ${style_directive}.`
    : "Artistic technique: High-contrast commercial vector screen-print graphic with bold linework and flat saturated colors.";

  return [
    `Generate a full-color 2D vector t-shirt graphic illustration directly of ${niche}, matching the composition, layout structure, and silhouette framing of the attached reference design.`,
    `Visual Subject: ${niche} rendered as the prominent central focal graphic, matching the scale, posture, and placement of the primary subject in the reference.`,
    `Composition: Centered apparel emblem layout replicating the reference architecture—structured hierarchy, matching frame geometry, balanced visual weight, and clean outer contours.`,
    `Typography: Recreate any lettering banners or text curves from the reference displaying "${niche}". Render crisp, legible vector typography integrated into the graphic. If the reference contains no text, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.`,
    styleClause,
    arDirective,
    bgBlock,
    UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}
