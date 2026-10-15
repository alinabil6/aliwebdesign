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
      `Generate a full-color 2D vector t-shirt graphic illustration directly fusing the subject matter of the first attached image (Primary Subject / Niche Reference) with the aesthetic style synthesized from the subsequent ${styleCount} attached images (Style References).`,
      "Visual Subject: Faithfully recreate the core character, silhouette, typography, and thematic elements from the first attached image (Image 1 - Subject) as the central focal artwork, reframed cleanly for the chosen canvas aspect ratio.",
      `Style Synthesis: Apply only the artistic rendering medium, line weight, textures (e.g., crochet stitches, embroidery loops, watercolor wash), and color palette synthesized from the subsequent attached style images (Images 2 through ${styleCount + 1} - Aesthetic Style) directly onto the subject from Image 1. Do NOT draw or copy the characters or subject matter from the style reference images.`,
      "Typography: If the first attached image (Image 1 - Subject) contains text, render that exact wording in the synthesized aesthetic style. If the first attached image contains no text, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.",
      arDirective,
      bgBlock,
      UNIVERSAL_FOOTER
    ].filter(Boolean).join("\n\n").trim();
  }

  return [
    "Generate a full-color 2D vector t-shirt graphic illustration directly fusing the subject matter of the first attached image (Primary Subject / Niche Reference) with the aesthetic style of the second attached image (Aesthetic Style Reference).",
    "Visual Subject: Faithfully recreate the core character, silhouette, typography, and thematic elements from the first attached image (Image 1 - Subject) as the central focal artwork, reframed cleanly for the chosen canvas aspect ratio.",
    "Artistic Style: Apply only the artistic rendering medium, line weight, textures (e.g., crochet stitches, embroidery loops, watercolor wash), and color palette of the second attached image (Image 2 - Aesthetic Style) directly onto the subject from Image 1. Do NOT draw or copy the characters or subject matter from the second attached image.",
    "Typography: If the first attached image (Image 1 - Subject) contains text, render that exact wording in the new aesthetic style. If the first attached image contains no text, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.",
    arDirective,
    bgBlock,
    UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}
