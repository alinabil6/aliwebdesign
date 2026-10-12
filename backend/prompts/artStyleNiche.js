import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";
import { UNIVERSAL_FOOTER } from "./textToImage.js";
import { buildAspectRatioDirective } from "../lib/aspectRatioEnforcer.js";

export function buildPrompt({ bg_color = "#000000", variant = 0, styleCount = 1, aspectRatio = "1:1" } = {}) {
  const bg = buildBackgroundBlock(bg_color);
  const arDirective = buildAspectRatioDirective(aspectRatio, { hasReferenceImage: true });

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  if (styleCount > 1) {
    return [
      `Generate a full-color 2D vector t-shirt graphic illustration directly fusing the subject matter of the attached final niche reference with the aesthetic style synthesized from the preceding ${styleCount} style images.`,
      "Visual Subject: Recreate the subject matter, character, and visual elements from the final attached niche image as the central focal artwork, reframed cleanly for the chosen canvas aspect ratio.",
      `Style Synthesis: Apply the unified artistic technique, linework, color palette, and textures from the style reference images directly onto the niche subject.`,
      "Typography: If the niche image contains text, render that exact wording in the synthesized aesthetic style. If the niche image contains no text, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.",
      arDirective,
      bgBlock,
      UNIVERSAL_FOOTER
    ].filter(Boolean).join("\n\n").trim();
  }

  return [
    "Generate a full-color 2D vector t-shirt graphic illustration directly fusing the subject matter of the attached second niche reference with the aesthetic style of the attached first style reference.",
    "Visual Subject: Recreate the core subject matter, character, and central elements from the attached niche reference, composed cleanly for the chosen canvas aspect ratio.",
    "Artistic Style: Apply the linework, color palette, artistic texture, and rendering technique of the first attached image directly onto the subject.",
    "Typography: If the second image contains text, render that exact wording in the new aesthetic style. If the second image contains no text, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.",
    arDirective,
    bgBlock,
    UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}
