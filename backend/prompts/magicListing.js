const COMMON_RULES = `
You are generating marketplace listing recommendations for a single uploaded design.

INPUTS:
1. The uploaded design image.
2. Optional reference notes supplied by the operator.

HARD RULES:
- Ground every claim in the uploaded design first.
- Use reference notes only when they reinforce what is visible.
- If the image is unclear, lower confidence and mark requires_manual_review true.
- Never invent brands, licenses, fandoms, protected slogans, celebrities, or events.
- Be explicit when a detail is inferred rather than directly visible.
- Prefer concise, accurate language over aggressive SEO.
- Return JSON only.

RETURN THIS EXACT TOP-LEVEL SHAPE:
{
  "suggested_title": "string",
  "suggested_category": "string",
  "suggested_price_range": {
    "min": 24.99,
    "max": 29.99,
    "currency": "USD",
    "label": "$24.99–$29.99"
  },
  "bullet_points": ["string", "string"],
  "confidence_score": 0.0,
  "requires_manual_review": true,
  "source": "vision|reference|vision+reference|fallback",
  "grounding_notes": ["string"],
  "description": "string",
  "platform_payload": {
    "title": "string"
  }
}
`;

const AMAZON_RULES = `
PLATFORM: Amazon Merch-style listing support.
- title: 60 chars max in platform_payload.title
- platform_payload.brand: 50 chars max
- platform_payload.bullet1 and bullet2: 256 chars max
- platform_payload.description: 500 chars max
- Do not use banned generic merch filler.
`;

const TEEPUBLIC_RULES = `
PLATFORM: TeePublic-style listing support.
- platform_payload.title: 40-80 chars
- platform_payload.description: 150-300 chars
- platform_payload.main_tag: 1-3 words
- platform_payload.supporting_tags: 6-10 high-signal tags
`;

const ETSY_RULES = `
PLATFORM: Etsy-style listing support.
- platform_payload.title: 140 chars max
- platform_payload.category: use a concise taxonomy-like phrase
- platform_payload.tags: up to 13 tags
- platform_payload.attributes: compact object of relevant listing attributes
`;

function block(label, value, fallback) {
  const text = String(value || '').trim();
  return `${label}:\n${text || fallback}`;
}

function composePrompt(platformRules, { referenceData = '', imageContext = '' } = {}) {
  return [
    COMMON_RULES.trim(),
    platformRules.trim(),
    block('REFERENCE DATA', referenceData, 'none provided'),
    block('IMAGE CONTEXT', imageContext, 'Inspect the attached design carefully.'),
    'Return only valid raw JSON.',
  ].join('\n\n');
}

export function buildMagicListingPrompt(input = {}) {
  return composePrompt(AMAZON_RULES, input);
}

export function buildTeePublicPrompt(input = {}) {
  return composePrompt(TEEPUBLIC_RULES, input);
}

export function buildEtsyPrompt(input = {}) {
  return composePrompt(ETSY_RULES, input);
}
