const COLOR_NAMES = {
  "#FFFFFF": "pure solid white",
  "#000000": "pitch black solid",
  "#F8FAFC": "solid clean off-white",
  "#1E293B": "solid dark slate charcoal",
  "#2563EB": "solid vibrant royal blue",
  "#16A34A": "solid rich green",
  "#EA580C": "solid vivid orange",
  "#DC2626": "solid crimson red",
};

export function buildBackgroundDirective(rawColor) {
  const color = String(rawColor || "").trim();

  if (color === "transparent") {
    return {
      prefix: "Canvas background: pure transparent background.",
      body: "Background specification:\n- Artwork isolated on a 100% clean transparent background.\n- Zero background artifacts, zero mockups, zero scenes, zero borders, and zero gradients.\n- Sharp vector contours with clean alpha channel separation.",
      suffix: "Artwork isolated on an empty, transparent canvas ready for screen-printing."
    };
  }

  const hexUpper = color.toUpperCase();
  const desc = COLOR_NAMES[hexUpper] || `solid uniform color (${color})`;

  return {
    prefix: `Canvas background: uniform ${desc} (${color}).`,
    body: `Background specification:\n- Flat, solid ${desc} (${color}) canvas surrounding the graphic edge-to-edge.\n- Zero gradients, zero lighting casts, zero drop shadows, zero textures, and zero vignettes.\n- Crisp, razor-sharp perimeter separation between the graphic subject and the solid ${color} background.`,
    suffix: `Isolated merchandise artwork centered on flat, seamless solid ${desc} (${color}) canvas.`
  };
}

export function normalizeBgColor(raw) {
  const v = String(raw || "").trim();
  return v === "transparent" || /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : "";
}

export function buildBackgroundBlock(raw) {
  const color = normalizeBgColor(raw);
  if (!color) {
    const empty = new String("");
    empty.prefix = "";
    empty.body = "";
    empty.suffix = "";
    return empty;
  }
  const bg = buildBackgroundDirective(color);
  const fullText = [bg.prefix, bg.body, bg.suffix].filter(Boolean).join("\n");
  const strObj = new String(fullText);
  strObj.prefix = bg.prefix;
  strObj.body = bg.body;
  strObj.suffix = bg.suffix;
  return strObj;
}
