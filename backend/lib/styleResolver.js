import { findStyleByName } from "./stylesRegistry.js";

const AESTHETIC_SUFFIX = " [CRITICAL SUBJECT-LOCK: Apply ONLY the artistic technique, linework, shading, texture, and color palette of this style to the provided base design. DO NOT generate random flora, fauna, specimens, charts, or thematic items mentioned in the style description unless they are explicitly present in the original design. The subject matter MUST remain 100% anchored to the provided reference artwork. DO NOT render these words as text.]";

/**
 * Resolve the effective style directive for a generation request.
 * Priority: manual style phrase (matched against catalog, else injected) -> auto-picked style -> none.
 *
 * @param {object} req - Express request with body fields
 * @returns {{style_id: string|null, style_name: string|null, style_directive: string}}
 */
export function resolveStyle(req) {
  const manualStyle = String(req.body.manualStyle || "").trim();
  const styleDirective = String(req.body.style_directive || "").trim();
  const styleName = String(req.body.style_name || "").trim() || null;
  const styleId = String(req.body.style_id || "").trim() || null;

  if (manualStyle) {
    const matched = findStyleByName(manualStyle);
    if (matched) {
      return {
        style_id: matched.id,
        style_name: matched.name,
        style_directive: matched.directive ? `${matched.directive}${AESTHETIC_SUFFIX}` : "",
      };
    }
    return {
      style_id: null,
      style_name: manualStyle,
      style_directive: `Artistic Style & Aesthetic: Apply the visual rendering techniques of ${manualStyle}.${AESTHETIC_SUFFIX}`,
    };
  }

  return {
    style_id: styleId,
    style_name: styleName,
    style_directive: styleDirective ? `${styleDirective}${AESTHETIC_SUFFIX}` : "",
  };
}