import { UNIVERSAL_FOOTER } from "./textToImage.js";

export function buildPrompt({ edit_instruction }) {
  return [
    `Generate a revised 2D vector t-shirt graphic illustration directly of the attached image applying this specific modification: ${edit_instruction}.`,
    "Preservation: Retain the identical composition, character silhouette, linework, and color scheme of the original design, altering only the requested element.",
    "Typography: If the edit instruction requests text modification, render crisp legible typography. If the design has no text, render 100% graphic-only artwork with strictly zero letters, numbers, words, or text.",
    UNIVERSAL_FOOTER
  ].join("\n\n").trim();
}