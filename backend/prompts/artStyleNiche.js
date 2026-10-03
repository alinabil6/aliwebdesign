import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";

export function buildPrompt({ bg_color = "#000000", variant = 0, styleCount = 1 } = {}) {
  const bg = buildBackgroundBlock(bg_color);

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  if (styleCount > 1) {
    return [
      `Generate a full-color 2D vector t-shirt graphic illustration fusing the subject matter of the attached final niche reference with the aesthetic style synthesized from the preceding ${styleCount} style images.`,
      `Subject & Composition: Recreate the subject matter, character, and layout composition from the final attached niche image as the central focal artwork.`,
      `Style Synthesis: Apply the unified artistic technique, linework, color palette, and textures from the style reference images directly onto the niche subject.`,
      "Typography: If the niche image contains text, render that exact wording in the synthesized aesthetic style. If the niche image contains no text, render 100% graphic-only artwork with zero words.",
      bgBlock,
      "Visual format: Flat 2D vector merchandise illustration, centered, sharp clean contours, solid single-color backdrop, print-ready commercial apparel asset. Zero t-shirt mockups, zero models, zero fabric creases, zero photorealism."
    ].filter(Boolean).join("\n\n").trim();
  }

  return [
    "Generate a full-color 2D vector t-shirt graphic illustration fusing the subject matter of the attached second niche reference with the aesthetic style of the attached first style reference.",
    "Subject & Composition: Recreate the exact subject matter, character, and composition from the second attached image as the central focal artwork.",
    "Artistic Style: Apply the linework, color palette, artistic texture, and rendering technique of the first attached image directly onto the subject.",
    "Typography: If the second image contains text, render that exact wording in the new aesthetic style. If the second image contains no text, render 100% graphic-only artwork with zero words.",
    bgBlock,
    "Visual format: Flat 2D vector merchandise illustration, centered, sharp clean contours, solid single-color backdrop, print-ready commercial apparel asset. Zero t-shirt mockups, zero models, zero fabric creases, zero photorealism."
  ].filter(Boolean).join("\n\n").trim();
}
