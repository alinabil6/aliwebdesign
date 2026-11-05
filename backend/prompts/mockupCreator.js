import { buildAspectRatioDirective } from "../lib/aspectRatioEnforcer.js";

/**
 * Universal Mockup Quality & Commercial Presentation Guardrails.
 * Explicitly triggers Gemini's Nano Banana 2 image generation engine directly.
 */
const MOCKUP_UNIVERSAL_FOOTER = [
  "Execute visual image generation directly via Nano Banana 2.",
  "Render high-resolution commercial merchandise photography with prime commercial apparel lens clarity (sharp focus, natural depth of field, authentic cotton textile weave).",
  "Strictly zero watermarks, zero fake cardboard packaging, zero unintended floating text, zero distortion artifacts, zero conversational commentary, and zero preambles."
].join(" ");

/**
 * Human Model & Character Realism Directive.
 * Enforces unretouched, candid smartphone realism, natural skin texture, and authentic apparel model posing.
 */
const HUMAN_MODEL_REALISM_DIRECTIVE = `HUMAN MODEL REALISM & NATURAL POSING (MANDATORY FOR ON-MODEL PRESENTATION):
If the reference image depicts a human model wearing the garment (or if an on-model presentation is rendered):
- PHOTOREALISTIC EVERYDAY SMARTPHONE-PHOTO REALISM (ANTI-SILICON / ANTI-AI PLASTIC):
  * Authentic, casual everyday smartphone-photo realism; spontaneous, natural, and candid rather than overly staged.
  * Natural human skin texture with visible fine pores, realistic slight natural sheen, and subtle natural freckles; light natural makeup.
  * STRICTLY FORBIDDEN: Plastic-looking, airbrushed, wax-figure, CGI doll, or over-smoothed AI silicon skin. Avoid uncanny valley aesthetics.
  * Natural smartphone colors, neutral white balance, normal contrast, and slightly vibrant natural skin saturation. Balanced exposure with soft, natural-looking shadows. Deep focus with realistic textures and slight natural sensor noise.
  * Avoid heavy cinematic or studio lighting, artificial HDR halos, and over-polished artistic-render styling.
- AUTHENTIC APPAREL MODEL FRAMING & CROPPING:
  * In top commercial apparel mockups (Etsy / Shopify best-sellers), models are typically cropped from the jawline, mouth, or collarbone down (showing lower face, mouth, neck, shoulders, and torso), keeping the viewer's primary visual focus squarely centered on the t-shirt and printed chest graphic.
  * Strictly preserve the cropping of Image 1! If Image 1 is cropped at the lower face or collar, replicate that exact clean commercial crop.
- NATURAL HUMAN BEHAVIOR & RELAXED ANATOMY:
  * Natural, casual, unstaged posing: hands resting naturally at the sides, fingers lightly hooked into jean pockets, or hands resting casually near the waist/belly as a real model wears the shirt.
  * Natural shoulder drape, realistic collarbone, genuine arms and waistline silhouette, and correct human anatomy with natural finger and hand detailing.
- FABRIC & DESIGN DRAPE ON MODEL:
  * The garment must fit naturally over the model's torso with realistic fabric wrinkles and drape.
  * The printed artwork from Image 2 must conform smoothly to the shirt's front chest contours while maintaining 100% legibility and fidelity.`;

/**
 * Builds rich, real-world textile color guidance for Gemini to accurately match
 * commercial apparel blank tones (Comfort Colors 1717, Bella+Canvas 3001, etc.).
 */
function buildColorDirective(garmentColor, productType) {
  if (!garmentColor || garmentColor === "transparent") {
    return `GARMENT FABRIC COLOR: Maintain the authentic fabric color, texture, and physical styling of the ${productType} from the reference image.`;
  }

  const lower = garmentColor.toLowerCase();
  let textileGuidance = "";

  if (lower.includes("sage green") || lower.includes("879f84")) {
    textileGuidance = "Authentic dusty muted earthy sage green (#879F84), matching commercial dyed apparel tones like Comfort Colors Sage or Bella+Canvas Dusty Green.";
  } else if (lower.includes("natural cream") || lower.includes("f5f0e6")) {
    textileGuidance = "Authentic unbleached natural raw cream / warm sand ivory (#F5F0E6), matching commercial apparel tones like Comfort Colors Ivory or Bella+Canvas Natural.";
  } else if (lower.includes("pepper") || lower.includes("charcoal") || lower.includes("3e3e3e")) {
    textileGuidance = "Authentic vintage washed pepper dark charcoal (#3E3E3E), matching Comfort Colors Pepper / Vintage Washed Black.";
  } else if (lower.includes("terracotta") || lower.includes("c66b4e")) {
    textileGuidance = "Authentic warm earthy terracotta rust / clay (#C66B4E), rich warm autumn tones.";
  } else if (lower.includes("navy") || lower.includes("1b2942")) {
    textileGuidance = "Authentic deep classic vintage navy blue (#1B2942) with rich dyed cotton depth.";
  } else if (lower.includes("black") || lower.includes("111111")) {
    textileGuidance = "Clean, rich commercial solid black (#111111) with visible fabric texture and natural lighting highlights.";
  } else if (lower.includes("white") || lower.includes("ffffff")) {
    textileGuidance = "Pristine, solid bright clean white cotton (#FFFFFF) with realistic textile shadows in fabric folds.";
  } else {
    textileGuidance = `Solid dyed commercial cotton fabric strictly matching ${garmentColor}.`;
  }

  return `GARMENT FABRIC COLOR SPECIFICATION (STRICT REQUIREMENT):
The target apparel garment (${productType}) MUST be rendered in ${garmentColor}.
- Color Match: ${textileGuidance}
- Apply this exact ${garmentColor} hue consistently across the entire body, rib knit collar, sleeve cuffs, and bottom hem of the ${productType}.
- Render realistic textile highlights, subtle shadow shading in fabric creases and drape, and natural surface depth.
- Regardless of whatever garment color appears in the attached reference, the output garment MUST strictly be ${garmentColor}.`;
}

/**
 * Builds atmosphere & background staging directives that strongly respect user scene prompts.
 */
function buildSceneDirective(sceneDirection) {
  if (sceneDirection && sceneDirection.trim()) {
    const raw = sceneDirection.trim();
    return `SCENE, BACKGROUND & ATMOSPHERE (HIGH PRIORITY STAGING):
The environment, surface staging, lighting, and decorative lifestyle props MUST thoroughly reflect: "${raw}".
- Thematic Vibe & Props: Actively incorporate the requested theme, seasonal styling, and props into the background arrangement surrounding the garment. For example, if autumn, Thanksgiving, or cozy vibes are specified, stage the scene with warm rustic wooden or textured neutral surfaces, soft autumn daylight, warm window shadows, and subtle tasteful seasonal accents (mini pumpkins, dried florals, autumn foliage, cozy linen/knit textures) neatly arranged in professional Etsy best-seller merchandise flatlay style.
- Composition Balance: All staging props and background elements must stay in the perimeter/surrounding area, keeping the garment body and chest print area 100% clean, flat, and unobstructed.
- Lighting: Professional soft natural diffuse daylight or warm directional sun rays with organic ambient shadows that naturally ground the apparel.`;
  }

  return `SCENE & BACKGROUND: Premium commercial apparel flatlay photography on a clean neutral background (e.g. textured linen or light warm wooden surface) with soft, diffuse daylight, balanced natural shadows, and elegant minimalist editorial styling. The garment must remain front and center without obstructions.`;
}

/**
 * Builds a highly-disciplined prompt for apparel mockup generation with pixel-exact design placement,
 * framing/crop preservation, clean fabric purging, and authentic Etsy/POD commercial quality.
 *
 * @param {Object} options
 * @param {boolean} options.hasArtwork Whether user supplied finished artwork to place
 * @param {string} options.productType Apparel category (e.g. 'Unisex T-Shirt', 'Sweatshirt', 'Hoodie')
 * @param {string} options.garmentColor Target garment color (e.g. 'White', 'Black', 'Natural Cream', 'Sage Green')
 * @param {string} options.sceneDirection Optional scene/background/lighting description
 * @param {string} options.aspectRatio Desired canvas aspect ratio ('1:1', '4:5', '9:16', '16:9')
 * @param {number} options.variant Variant index (0..count-1)
 * @returns {string} Fully structured prompt for Gemini
 */
export function buildPrompt({
  hasArtwork = false,
  productType = "Unisex T-Shirt",
  garmentColor = "",
  sceneDirection = "",
  aspectRatio = "1:1",
  variant = 0,
} = {}) {
  const arDirective = buildAspectRatioDirective(aspectRatio, { hasReferenceImage: true });
  const colorDirective = buildColorDirective(garmentColor, productType);
  const sceneDirective = buildSceneDirective(sceneDirection);

  // ──────────────────────────────────────────────────────────────────────────
  // CASE A: Finished Artwork Provided -> Design Swap & Frozen Placement
  // ──────────────────────────────────────────────────────────────────────────
  if (hasArtwork) {
    return [
      `You are an elite commercial merchandise photographer creating top 1% best-seller apparel mockups for Etsy, Shopify, and Print-on-Demand (POD) brands.`,
      `PRIMARY TASK:
Produce a photorealistic commercial apparel mockup photograph featuring the ${productType} from Image 1, displaying the EXACT graphic artwork from Image 2 seamlessly printed on the front chest center.`,

      `MANDATORY DESIGN OVERWRITE & COMPETITOR GRAPHIC PURGE (CRITICAL):
- IMAGE 1 is an existing mockup photograph from a competitor, template, or store that may ALREADY have a printed graphic, illustration (such as a girl, turkey, holiday character, badge, or cartoon), logo, or text printed on it.
- YOU ARE STRICTLY PROHIBITED FROM COPYING, DRAWING, RE-RENDERING, OR PRESERVING ANY GRAPHIC, ILLUSTRATION, OR TEXT VISIBLE IN IMAGE 1.
- The graphic on Image 1 is an unwanted placeholder. It must be 100% ERASED, PURGED, AND WIPED OFF THE SHIRT.
- You must ONLY AND EXCLUSIVELY render the artwork provided in Image 2 onto the garment.
- Any output that depicts the design from Image 1 is an absolute failure. Image 2 is your sole, mandatory, and exclusive artwork source.`,

      `CRITICAL PIXEL-LEVEL ARTWORK INTEGRITY & ZERO BLACK BOX ARTIFACTS:
Treat Image 2 as a frozen, immutable design asset.
- DO NOT alter, redraw, re-interpret, modify, stylize, simplify, recolor, or change any part of the graphic from Image 2.
- DO NOT invent, remove, correct, replace, scramble, or distort any lettering, text, words, fonts, typography, characters, or illustrative details. Every line, element, word, and color from Image 2 must appear exactly as originally designed.
- ZERO BLACK BACKGROUND BOXES OR OUTLINES: The graphic artwork from Image 2 must be printed directly onto the fabric with clean, organic edges. DO NOT print a black rectangular box, dark square background patch, artificial outer stroke, or cardboard frame around the artwork. All negative space and background areas around or within the artwork elements MUST seamlessly reveal the natural dyed fabric color of the shirt (${garmentColor}).
- NATURAL APPAREL PRINTING: Accurately map and composite this exact graphic onto the front chest center print area of the ${productType}. Conform the artwork naturally to the gentle surface contours, subtle fabric folds, and ambient lighting of the garment so it appears authentically printed directly onto the fabric (realistic direct-to-garment DTG or soft-hand screen print), while keeping the original graphic sharp, clear, legible, and uncorrupted.`,

      `OPTIMAL APPAREL SCALE, PROMINENCE & MEDIUM-CLOSE FRAMING:
- HIGH-VISIBILITY PRINT SCALE: The graphic print must be prominently scaled across the chest print area (occupying a generous, eye-catching commercial print proportion of approximately 30% to 40% of the visible shirt width). It must NOT be a tiny, distant, or miniature graphic.
- MEDIUM-CLOSE COMMERCIAL FRAMING (ELIMINATE FAR-AWAY DISTANT SHOTS):
  * Position the camera in a medium-close commercial apparel crop or high-impact flatlay where the garment generously fills 75% to 85% of the frame.
  * AVOID wide-angle, distant, pulled-back camera shots that leave excessive empty space around the garment. The customer browsing an online shop on a mobile screen MUST be able to immediately see, read, and appreciate every detail of the design without having to manually zoom in.
  * If Image 1 shows a folded t-shirt or tight chest/collar crop (like top-selling Etsy shop listings), render that exact close-up commercial presentation.
  * If Image 1 shows a full t-shirt, frame it tightly from collar to hem so it fills the canvas boldly and prominently.
- CAMERA ANGLE: 2D commercial flatlay or direct frontal view facing squarely towards the viewer. Strictly avoid awkward 3D perspective tilts, angled side views, or unnatural garment warping. The product must be cleanly presented towards the camera.`,

      HUMAN_MODEL_REALISM_DIRECTIVE,
      colorDirective,
      sceneDirective,

      `COMMERCIAL POD BEST-SELLER EXECUTION:
- Authentic commercial merchandise photography suitable for top Etsy listings.
- Rich cotton fabric texture with delicate natural wrinkles and realistic garment seams.
- Clean, professional lighting with crisp focal clarity across the garment and artwork.`,

      arDirective,
      MOCKUP_UNIVERSAL_FOOTER
    ].filter(Boolean).join("\n\n").trim();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CASE B: Blank Mockup Mode (No Artwork Provided) -> Pure Clean Unprinted Apparel
  // ──────────────────────────────────────────────────────────────────────────
  return [
    `You are an elite commercial merchandise photographer creating top 1% best-seller blank apparel mockups for Etsy, Shopify, and Print-on-Demand (POD) creators.`,
    `PRIMARY TASK:
Produce a photorealistic commercial BLANK apparel mockup photograph of the ${productType} shown in the attached reference image, styled and staged for commercial digital product listings.`,

    `CRITICAL MANDATORY PURGE: 100% BLANK UNPRINTED GARMENT (ZERO GRAPHICS / ZERO TEXT):
- The attached reference image may feature an existing printed graphic, slogan, illustration, logo, embroidery, or text.
- YOU MUST COMPLETELY ERASE, REMOVE, AND EXCLUDE ALL EXISTING ARTWORK, TEXT, PRINTS, LOGOS, AND EMBROIDERY from the reference garment.
- The resulting ${productType} MUST BE 100% SOLID, BLANK, UNPRINTED, AND PRISTINE FABRIC.
- Under NO circumstances render any illustration, cartoon, slogan, lettering, badge, or remnants from the reference image.
- The chest, sleeves, and body must be completely smooth, clean solid fabric ready for commercial artwork placement.`,

    `GARMENT FRAMING, SCALE & PERSPECTIVE (STRICT MATCH TO REFERENCE):
- HIGH-IMPACT SCALE: Scale up the ${productType} so it generously fills 75% to 85% of the commercial frame (centered, generous commercial scale, not tiny or floating far away).
- RESPECT REFERENCE FRAMING AND CROP:
  * If the reference image shows a folded t-shirt showing just the chest/collar, authentically preserve that exact commercial folded arrangement and close-up framing.
  * If the reference image shows a full flatlay t-shirt, frame it tightly so it fills the canvas boldly.
- CAMERA ANGLE: Direct 2D frontal flatlay facing squarely towards the viewer. Avoid awkward 3D angled tilts or distorted perspectives.`,

    HUMAN_MODEL_REALISM_DIRECTIVE,
    colorDirective,
    sceneDirective,

    `COMMERCIAL POD BEST-SELLER EXECUTION:
- Clean commercial merchandise photography with realistic cotton texture, authentic seams, and natural textile drape.
- Sharp focus on the fabric, soft natural shadows, and pristine, high-converting Etsy shop aesthetic.`,

    arDirective,
    MOCKUP_UNIVERSAL_FOOTER
  ].filter(Boolean).join("\n\n").trim();
}
