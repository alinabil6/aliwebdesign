import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";
import { UNIVERSAL_FOOTER } from "./textToImage.js";
import { buildAspectRatioDirective } from "../lib/aspectRatioEnforcer.js";

export const POSTER_PROMPT = `Ultra-high-definition painterly illustration redraw directly from the attached reference artwork.

Visual Subject: High-fidelity redraw faithfully preserving the subject, composition, atmospheric mood, color palette, lighting conditions, painterly textures, and illustrative character of the reference. Preserve every recognizable element — creatures, plants, objects, spatial relationships — exactly as they appear in the reference.

Quality: Render pristine print-ready artwork with rich depth, fine detail, accurate tonal range, and zero pixelation, blur, or compression artifacts.

Artistic Technique: Match the medium of the reference — painterly digital illustration with atmospheric lighting, soft and hard edge variation, detailed feather/fur/fabric texture rendering, depth-of-field atmosphere. Do NOT apply flat vector style, solid color fills, outline strokes, or cartoon simplification.

Background: Fully preserve the original background — its atmosphere, environment, gradients, lighting cast, and mood. Do NOT replace the background with solid black or any flat color.

Aspect Ratio & Canvas: 4:5 portrait format (vertical, taller than wide). Re-compose and re-frame the design to fit strictly inside this vertical portrait canvas regardless of the original aspect ratio of the input.

Typography: Re-render any existing text or signatures from the reference with crisp, perfectly aligned typography at the same position. If the reference is graphic-only, output strictly zero text.

Zero mockups, zero models, zero fabric creases, zero photorealism of real humans. Render high-resolution artwork directly.`;

export function buildPrompt({
  bg_color = "",
  style_directive = "",
  style_name = "",
  variant = 0,
  aspectRatio = "1:1",
  mode = "design",
} = {}) {
  if (String(mode).toLowerCase() === "poster") {
    return POSTER_PROMPT;
  }

  const bg = buildBackgroundBlock(bg_color);
  const arDirective = buildAspectRatioDirective(aspectRatio, { hasReferenceImage: true });

  const styleClause = style_directive
    ? `Artistic technique: ${style_name || "vector redraw"}. ${style_directive} (Maintain exact subject fidelity while applying this rendering technique).`
    : "Artistic technique: High-definition 2D vector apparel illustration with razor-sharp contours, smooth curves, and clean solid color fills.";

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  return [
    "Generate an ultra-high-definition 2D vector t-shirt graphic redraw directly from the attached reference artwork.",
    "Visual Subject: High-fidelity vector redraw of the attached artwork—faithfully preserving the subject characters, recognizable visual elements, detailed silhouette contours, and artistic character.",
    "Quality & Resolution: Render pristine print-ready vector artwork with razor-sharp edges, smooth curves, rich saturated colors, and zero pixelation, blur, or compression artifacts.",
    "Typography: Re-render any existing text from the reference with crisp, perfectly aligned vector typography. Do not output style names, prompt words, or metadata as text. If the reference is graphic-only, output strictly zero letters, numbers, words, or text.",
    styleClause,
    arDirective,
    bgBlock,
    UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}
