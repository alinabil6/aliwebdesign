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
    "Generate a modernized 2D vector t-shirt graphic illustration directly redrawing the attached artwork into a fresh apparel design.",
    "Visual Subject: Redraw the central illustration, characters, vehicles, and key visual elements from the reference artwork into a dynamic new vector merchandise graphic.",
    "Composition: Centered apparel emblem composition with crisp outer contours, strong silhouette, balanced elements, and high-contrast color separation.",
    "Typography: Recreate any lettering or slogans from the reference design in sharp, clean, legible vector typography integrated into the emblem. If the reference design contains no text, render a pure visual illustration with strictly zero letters, numbers, words, or text.",
    styleClause,
    arDirective,
    bgBlock,
    UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}