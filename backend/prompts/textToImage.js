import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";

const VARIANT_STYLES = [
  "clean bold vector",
  "minimal graphic",
  "vintage screen print",
  "retro illustrated",
];

export function buildPrompt({
  prompt,
  variant = 0,
  style_directive = "",
  style_name = "",
  bg_color = ""
}) {
  const bg = buildBackgroundBlock(bg_color);
  const style = VARIANT_STYLES[variant % VARIANT_STYLES.length];
  const concept = String(prompt || "").trim();

  const styleClause = style_directive
    ? `Artistic style: ${style_name || style}. ${style_directive}.`
    : `Artistic style: ${style} with bold line art, crisp contours, and vibrant flat color separation.`;

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

  return [
    `Generate a full-color 2D vector t-shirt graphic illustration of: ${concept}.`,
    `Subject & Composition: ${concept}, composed with a strong central focal point, balanced visual weight, dynamic silhouette, and apparel-ready framing.`,
    styleClause,
    "Typography: If text is explicitly specified in the concept, render sharp legible lettering integrated naturally into the graphic layout. If no text is mentioned in the concept, render a 100% graphic-only illustration with zero words, letters, or numbers.",
    bgBlock,
    "Visual format: Flat 2D vector merchandise illustration, centered, sharp clean contours, solid single-color backdrop, print-ready commercial apparel asset. Zero t-shirt mockups, zero models, zero fabric creases, zero photorealism."
  ].filter(Boolean).join("\n\n").trim();
}