import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";
import { buildAspectRatioDirective } from "../lib/aspectRatioEnforcer.js";

const VARIANT_STYLES = [
  "clean bold vector",
  "minimal graphic",
  "vintage screen print",
  "retro illustrated",
];

export const UNIVERSAL_FOOTER =
  "Flat 2D vector merchandise graphic, centered, crisp contours, solid clean background. Zero mockups, zero models, zero fabric creases, zero photorealism. Execute visual image generation directly via Nano Banana 2. Render high-resolution merchandise artwork directly; strictly zero conversational text, zero commentary, zero explanations, and zero preambles.";

export function buildPrompt({
  prompt,
  variant = 0,
  style_directive = "",
  style_name = "",
  bg_color = "",
  aspectRatio = "1:1",
  hasReferenceImage = false,
  referenceCount = 0,
}) {
  const bg = buildBackgroundBlock(bg_color);
  const style = VARIANT_STYLES[variant % VARIANT_STYLES.length];
  const concept = String(prompt || "").trim();
  const arDirective = buildAspectRatioDirective(aspectRatio, { hasReferenceImage: Boolean(hasReferenceImage || referenceCount > 0) });

  const styleClause = style_directive
    ? `Artistic technique: ${style_name || style}. ${style_directive}.`
    : `Artistic technique: ${style} with bold line art, crisp contours, and vibrant flat color separation.`;

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  const effectiveCount = Math.max(referenceCount || 0, hasReferenceImage ? 1 : 0);

  // Multi-reference combination prompt
  if (effectiveCount > 1) {
    return [
      `Generate a fresh, commercial 2D vector apparel graphic synthesizing and combining all ${effectiveCount} attached reference designs, executing the following concept: ${concept}.`,
      `Multi-Reference Combination & Synthesis: Analyze and combine the visual subjects, distinct art styles, color palettes, illustrative motifs, and aesthetic cues across all ${effectiveCount} attached reference images into a unified, original composition for: ${concept}. Seamlessly fuse their key artistic elements, harmonious textures, and visual hooks into a single cohesive artwork with a prominent focal point, dynamic silhouette, and apparel-ready framing.`,
      styleClause,
      "Typography: If lettering is explicitly requested in the concept, render sharp legible vector typography integrated into the emblem. If no text is requested in the concept, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.",
      arDirective,
      bgBlock,
      UNIVERSAL_FOOTER
    ].filter(Boolean).join("\n\n").trim();
  }

  // Single-reference prompt
  if (effectiveCount === 1) {
    return [
      `Generate a fresh, commercial 2D vector apparel graphic inspired by the attached reference design, executing the following concept: ${concept}.`,
      `Visual Subject & Reference Guidance: Draw direct inspiration from the composition, visual aesthetic, mood, and illustrative character of the attached reference design, while generating the new subject: ${concept}. Maintain balanced visual weight, dynamic silhouette, and apparel-ready framing.`,
      styleClause,
      "Typography: If lettering is explicitly requested in the concept, render sharp legible vector typography integrated into the emblem. If no text is requested in the concept, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.",
      arDirective,
      bgBlock,
      UNIVERSAL_FOOTER
    ].filter(Boolean).join("\n\n").trim();
  }

  return [
    `Generate a full-color 2D vector t-shirt graphic illustration directly of: ${concept}.`,
    `Visual Subject: ${concept}, composed with a prominent central focal point, balanced visual weight, dynamic silhouette, and apparel-ready framing.`,
    styleClause,
    "Typography: If lettering is explicitly requested in the concept, render sharp legible vector typography integrated into the emblem. If no text is requested in the concept, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.",
    arDirective,
    bgBlock,
    UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}
