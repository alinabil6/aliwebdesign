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

export const TEXT_ONLY_PROMPT = `STRICT TYPOGRAPHY-ONLY TASK. NO ILLUSTRATION OF ANY KIND.

The attached image contains ONLY text. Recreate it as a clean, print-ready typographic graphic. The output MUST contain ONLY text.

**ABSOLUTE RULES (mandatory, no exceptions)**
1. Every visible non-background pixel MUST belong to a character from the reference text. The output is letters only, plus punctuation and symbols exactly as in the reference.
2. NEVER draw anything that is not a character: no objects, people, animals, props, icons, emblems, shapes, lines, bars, boxes, underlines, frames, borders, badges, ribbons, circles, rings, loops, arches, or dividers.
3. NEVER illustrate, visualize, or represent the joke or its meaning. Never draw what the words describe.
4. NEVER bend, curve, arc, warp, or place text on a path or shape. All lines stay straight and horizontal.
5. NEVER add, remove, reorder, rephrase, repeat, translate, or correct any word, character, or punctuation. Symbols such as ( ) = ! ? are part of the text and MUST be kept.
6. NEVER add textures, distress, shadows, glows, outlines, gradients, 3D effects, or backgrounds behind the text unless the reference already has them.
7. Use ONLY the exact text color(s) of the reference. NEVER introduce a new color. If the reference text color would not be readable on the requested canvas background, use one single high-contrast color (black on light, white on dark) and nothing else.

**WHAT MUST STAY THE SAME**
The exact words, spelling, punctuation, and capitalization. The text color(s). The overall letter mood (clean sans stays a clean sans family, hand-drawn stays hand-drawn, distressed stays distressed). The humor and tone.

**WHAT MUST BE VISIBLY DIFFERENT (mandatory)**
The result must NOT look like the reference redrawn. A person comparing the two must immediately see a different typographic layout. Change at least FOUR of these:
- Line breaks: group the words into different lines than the reference.
- Size hierarchy: choose a different key word or punchline to be the largest, and make the supporting words clearly smaller.
- Alignment: change it (for example centered becomes left-aligned, or a staggered/indented stack).
- Typeface: use a different typeface within the same mood family (a different weight, width, or style of the same kind of lettering).
- Weight contrast: mix bold and light, or condensed and wide, between lines.
- Spacing: tracking and line spacing noticeably tighter or looser, with the text block shaped differently (tall and narrow, or wide and compact).
- Word emphasis: one word or short phrase set much larger than the rest.

All changes must stay inside the rules above: text only, straight horizontal lines, no shapes, no lines, no decoration, no new colors.

**Canvas**
Use a strict 4:5 canvas with a uniform solid #000000 background. Center the text block with generous margins. No mockup, model, garment, or fabric.

**FINAL CHECK before returning the image**
Is the layout, line breaking, or hierarchy the same as the reference? If yes, redo it with a clearly different arrangement.
Does the image contain anything other than the exact reference text? If yes, remove it. Is any text curved, boxed, or underlined? If yes, straighten it. Is any word changed, missing, or duplicated? If yes, fix it. Return only the finished image.`;

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
      "STRICT TYPOGRAPHY-ONLY TASK. NO ILLUSTRATION OF ANY KIND.",
      "The attached image contains ONLY text. Recreate it as a clean, print-ready typographic graphic. The output MUST contain ONLY text.",
      "**ABSOLUTE RULES (mandatory, no exceptions)**\n1. Every visible non-background pixel MUST belong to a character from the reference text. The output is letters only, plus punctuation and symbols exactly as in the reference.\n2. NEVER draw anything that is not a character: no objects, people, animals, props, icons, emblems, shapes, lines, bars, boxes, underlines, frames, borders, badges, banners, ribbons, circles, rings, loops, arches, or dividers.\n3. NEVER illustrate, visualize, or represent the joke or its meaning. Never draw what the words describe.\n4. NEVER bend, curve, arc, warp, or place text on a path or shape. All lines stay straight and horizontal.\n5. NEVER add, remove, reorder, rephrase, repeat, translate, or correct any word, character, or punctuation. Symbols such as ( ) = ! ? are part of the text and MUST be kept.\n6. NEVER add textures, distress, shadows, glows, outlines, gradients, 3D effects, or backgrounds behind the text unless the reference already has them.\n7. Use ONLY the exact text color(s) of the reference. NEVER introduce a new color. If the reference text color would not be readable on the requested canvas background, use one single high-contrast color (black on light, white on dark) and nothing else.",
      "**WHAT MUST STAY THE SAME**\nThe exact words, spelling, punctuation, and capitalization. The text color(s). The overall letter mood (clean sans stays a clean sans family, hand-drawn stays hand-drawn, distressed stays distressed). The humor and tone.",
      "**WHAT MUST BE VISIBLY DIFFERENT (mandatory)**\nThe result must NOT look like the reference redrawn. A person comparing the two must immediately see a different typographic layout. Change at least FOUR of these:\n- Line breaks: group the words into different lines than the reference.\n- Size hierarchy: choose a different key word or punchline to be the largest, and make the supporting words clearly smaller.\n- Alignment: change it (for example centered becomes left-aligned, or a staggered/indented stack).\n- Typeface: use a different typeface within the same mood family (a different weight, width, or style of the same kind of lettering).\n- Weight contrast: mix bold and light, or condensed and wide, between lines.\n- Spacing: tracking and line spacing noticeably tighter or looser, with the text block shaped differently (tall and narrow, or wide and compact).\n- Word emphasis: one word or short phrase set much larger than the rest.\n\nAll changes must stay inside the rules above: text only, straight horizontal lines, no shapes, no lines, no decoration, no new colors.",
      canvasBlock,
      "**FINAL CHECK before returning the image**\nIs the layout, line breaking, or hierarchy the same as the reference? If yes, redo it with a clearly different arrangement.\nDoes the image contain anything other than the exact reference text? If yes, remove it. Is any text curved, boxed, or underlined? If yes, straighten it. Is any word changed, missing, or duplicated? If yes, fix it. Return only the finished image.",
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
