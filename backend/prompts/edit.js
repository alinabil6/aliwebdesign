import { OUTPUT_REQUIREMENTS } from "./nicheVariations.js";

export function buildPrompt({ edit_instruction }) {
  return [
    `Generate a revised 2D vector t-shirt graphic illustration of the attached image applying this specific modification: ${edit_instruction}.`,
    "Preservation: Retain the identical composition, character silhouette, linework, and color scheme of the original design, altering only the requested element.",
    OUTPUT_REQUIREMENTS
  ].join("\n\n").trim();
}