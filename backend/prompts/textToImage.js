import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";

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
  aspectRatio = "1:1"
}) {
  const bg = buildBackgroundBlock(bg_color);
  const style = VARIANT_STYLES[variant % VARIANT_STYLES.length];
  const concept = String(prompt || "").trim();
  const ar = String(aspectRatio || "1:1").trim();
  const arDirective = ar && ar !== "1:1" ? `Aspect ratio: ${ar} (--ar ${ar}). Design canvas structured strictly to ${ar} aspect ratio format.` : "";

  const styleClause = style_directive
    ? `Artistic technique: ${style_name || style}. ${style_directive}.`
    : `Artistic technique: ${style} with bold line art, crisp contours, and vibrant flat color separation.`;

  const bgBlock = bg
    ? String(bg)
    : "Background canvas: Clean solid monochrome backdrop for clean silhouette clipping.";

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