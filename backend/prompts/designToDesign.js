import { buildBackgroundBlock } from "../lib/backgroundEnforcer.js";
import { buildAspectRatioDirective } from "../lib/aspectRatioEnforcer.js";

export const DEFAULT_DESIGN_TO_DESIGN_PROMPT = `Redesign the attached reference into a fresh apparel graphic.

Treat the reference as a **concept brief, not a layout to copy**. Understand its main subject, meaning, joke or message, mood, and defining visual details. Then create a new, coherent design that communicates the same idea.

**Keep the idea recognizable**
Preserve the central subject, the visual hook, and the few details that make this particular design recognizable. Keep the original wording exactly as shown, if any. Do not add a new message or change the meaning.

**Make it look newly designed**
Create a new composition from scratch. Change the overall silhouette and the placement and scale of the main elements. Where the subject allows, change its pose, angle, or framing too. Build a clear new visual hierarchy and use negative space deliberately.

Do not merely move, rotate, mirror, resize, recolor, or decorate the original arrangement. Do not scatter pieces or letters around the canvas. Make the elements work together as one intentional design, with a clear focal point and a strong, readable silhouette.

**Respect the reference’s style**
Keep the same broad artistic style and medium as the reference, including its characteristic linework, shapes, texture, and color mood. Adapt that style to the new composition. Do not automatically turn the artwork into a vector, cartoon, vintage print, or another style unless the reference already uses it.

**Keep the artwork clear**
If the reference contains text, reproduce each visible phrase exactly, once, and make it easy to read. Do not invent, omit, duplicate, correct, fragment, distort, or cover any words. You may redesign the lettering and its placement. If there is no text, add none.

Keep important details distinct. Avoid clutter, accidental overlaps, duplicate subjects, and unrelated decoration. Make the result feel polished and suitable for apparel printing.

**Canvas**
Use a strict 4:5 portrait canvas with a uniform solid pitch-black background (#000000). Center the complete design, adapt its composition to the portrait frame, and keep the artwork sharply separated from the background. No mockup, model, garment, or fabric.

The finished design should clearly express the same core idea as the reference, while looking like a different, carefully composed artwork. Generate the image directly and return only the finished image.`;

export const TEXT_ONLY_PROMPT = `Redesign the attached text-based shirt graphic into a new typographic layout.

This design is typography only. The words are the entire design. The humor comes from the wording, not from any imagery.

**Text**
Reproduce every word exactly as written, once, with the same spelling and punctuation. Do not add, remove, reorder, rephrase, or repeat any words.

**What you may change**
- The line breaks and the arrangement of the lines
- The size hierarchy: emphasize the punchline or key words with bigger or bolder lettering
- The letterforms, within the same type family and mood as the reference (hand-drawn stays hand-drawn, clean sans stays clean sans, distressed stays distressed)
- The alignment, such as stacked, staggered, or left-aligned, as long as it stays simple and balanced

**What you must NOT add**
No illustrations, icons, symbols, characters, people, objects, or scenes. No borders, frames, banners, badges, ribbons, circles, ropes, stars, or dividers. No textures, shadows, glows, gradients, or decorative flourishes. No new colors. If the reference has one small graphic element (such as a power icon replacing a letter), keep only that element and nothing else.

**Color and style**
Use only the colors in the reference. For a white-on-black design, that means pure white text only. If the canvas background is different from the reference's background and the reference's text color would not be clearly readable on it, switch the text to a single high-contrast color (black on light backgrounds, white on dark backgrounds). Never introduce any other color. Keep the same tone, whether it is sassy, minimal, or bold.

**Canvas**
Use a strict 4:5 canvas with a uniform solid #000000 background. Center the text block with generous margins. No mockup, model, garment, or fabric.

The result should look like the same shirt, typeset a little differently. Simple, clean, and print-ready. Generate the image directly and return only the finished image.`;

export function buildPrompt({
  mode = "illustrated",
  bg_color = "#000000",
  style_directive = "",
  style_name = "",
  variant = 0,
  aspectRatio = "4:5",
} = {}) {
  const normRatio = String(aspectRatio || "4:5").trim();
  const normBg = String(bg_color || "#000000").trim();
  const isTextOnly = mode === "text_only";

  // If user kept the exact default 4:5 and #000000 black canvas without style override:
  if (
    (!style_directive || !style_directive.trim()) &&
    normRatio === "4:5" &&
    normBg.toLowerCase() === "#000000"
  ) {
    return isTextOnly ? TEXT_ONLY_PROMPT : DEFAULT_DESIGN_TO_DESIGN_PROMPT;
  }

  // If the user customized the background, aspect ratio, or applied a style override in the UI,
  // adapt the Canvas section and attach secondary system directives.
  const bgDirective = normBg && normBg.toLowerCase() !== "#000000" ? buildBackgroundBlock(normBg) : "";
  const arDirective = normRatio && normRatio !== "4:5" ? buildAspectRatioDirective(normRatio, { hasReferenceImage: true }) : "";
  const styleClause = style_directive ? `Style specification: ${style_name || "custom style"}. ${style_directive}.` : "";

  const canvasBlock = isTextOnly
    ? `**Canvas**\nUse a strict ${normRatio} canvas${normBg && normBg !== "transparent" ? ` with a uniform solid ${normBg} background` : (normBg === "transparent" ? " with clean isolated background" : " with a uniform solid pitch-black background (#000000)")}. Center the text block with generous margins. No mockup, model, garment, or fabric.`
    : `**Canvas**\nUse a strict ${normRatio} canvas${normBg && normBg !== "transparent" ? ` with a uniform solid ${normBg} background` : (normBg === "transparent" ? " with clean isolated background" : " with a uniform solid pitch-black background (#000000)")}. Center the complete design, adapt its composition to the frame, and keep the artwork sharply separated from the background. No mockup, model, garment, or fabric.`;

  if (isTextOnly) {
    return [
      "Redesign the attached text-based shirt graphic into a new typographic layout.",
      "This design is typography only. The words are the entire design. The humor comes from the wording, not from any imagery.",
      "**Text**\nReproduce every word exactly as written, once, with the same spelling and punctuation. Do not add, remove, reorder, rephrase, or repeat any words.",
      "**What you may change**\n- The line breaks and the arrangement of the lines\n- The size hierarchy: emphasize the punchline or key words with bigger or bolder lettering\n- The letterforms, within the same type family and mood as the reference (hand-drawn stays hand-drawn, clean sans stays clean sans, distressed stays distressed)\n- The alignment, such as stacked, staggered, or left-aligned, as long as it stays simple and balanced",
      "**What you must NOT add**\nNo illustrations, icons, symbols, characters, people, objects, or scenes. No borders, frames, banners, badges, ribbons, circles, ropes, stars, or dividers. No textures, shadows, glows, gradients, or decorative flourishes. No new colors. If the reference has one small graphic element (such as a power icon replacing a letter), keep only that element and nothing else.",
      "**Color and style**\nUse only the colors in the reference. For a white-on-black design, that means pure white text only. If the canvas background is different from the reference's background and the reference's text color would not be clearly readable on it, switch the text to a single high-contrast color (black on light backgrounds, white on dark backgrounds). Never introduce any other color. Keep the same tone, whether it is sassy, minimal, or bold.",
      canvasBlock,
      "The result should look like the same shirt, typeset a little differently. Simple, clean, and print-ready. Generate the image directly and return only the finished image.",
      styleClause,
      arDirective,
      bgDirective
    ].filter(Boolean).join("\n\n").trim();
  }

  return [
    "Redesign the attached reference into a fresh apparel graphic.",
    "Treat the reference as a **concept brief, not a layout to copy**. Understand its main subject, meaning, joke or message, mood, and defining visual details. Then create a new, coherent design that communicates the same idea.",
    "**Keep the idea recognizable**\nPreserve the central subject, the visual hook, and the few details that make this particular design recognizable. Keep the original wording exactly as shown, if any. Do not add a new message or change the meaning.",
    "**Make it look newly designed**\nCreate a new composition from scratch. Change the overall silhouette and the placement and scale of the main elements. Where the subject allows, change its pose, angle, or framing too. Build a clear new visual hierarchy and use negative space deliberately.\n\nDo not merely move, rotate, mirror, resize, recolor, or decorate the original arrangement. Do not scatter pieces or letters around the canvas. Make the elements work together as one intentional design, with a clear focal point and a strong, readable silhouette.",
    "**Respect the reference’s style**\nKeep the same broad artistic style and medium as the reference, including its characteristic linework, shapes, texture, and color mood. Adapt that style to the new composition. Do not automatically turn the artwork into a vector, cartoon, vintage print, or another style unless the reference already uses it.",
    "**Keep the artwork clear**\nIf the reference contains text, reproduce each visible phrase exactly, once, and make it easy to read. Do not invent, omit, duplicate, correct, fragment, distort, or cover any words. You may redesign the lettering and its placement. If there is no text, add none.\n\nKeep important details distinct. Avoid clutter, accidental overlaps, duplicate subjects, and unrelated decoration. Make the result feel polished and suitable for apparel printing.",
    canvasBlock,
    "The finished design should clearly express the same core idea as the reference, while looking like a different, carefully composed artwork. Generate the image directly and return only the finished image.",
    styleClause,
    arDirective,
    bgDirective
  ].filter(Boolean).join("\n\n").trim();
}
