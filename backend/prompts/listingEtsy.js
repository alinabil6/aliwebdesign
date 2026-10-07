// Magic Listing — Etsy SEO Prompt
// Conservative SEO: High-relevance search terms, structured taxonomy, 13 distinct tags.

const RULES = `
Generate an accurate, structured, high-conversion Etsy listing for ONLY the provided design.

INPUT:
1. REFERENCE DATA: optional keywords, niche information, or research notes.
2. VISUAL INSPECTION: the uploaded artwork design.

FIRST identify:
- Exact visual subject & artwork style (e.g. vintage vector, botanical line art, retro typography, cottagecore, etc.)
- Primary niche and target recipient/occasion
- Slogans, quotes, or lettering present in the graphic
- Strongest Etsy buyer search phrases

JSON SCHEMA FORMAT (Return strictly valid JSON):
{
  "title": "string",
  "category": "string",
  "attributes": {
    "primaryColor": "string",
    "style": "string",
    "occasion": "string",
    "recipient": "string",
    "graphic": "string"
  },
  "tags": [
    "tag 1",
    "tag 2",
    "tag 3",
    "tag 4",
    "tag 5",
    "tag 6",
    "tag 7",
    "tag 8",
    "tag 9",
    "tag 10",
    "tag 11",
    "tag 12",
    "tag 13"
  ],
  "description": "string",
  "trademark_safe": true
}

SPECIFIC FIELD RULES:

TITLE:
- Strict limit: Maximum 140 characters.
- Structured with high-search-volume phrases separated by commas or pipes (e.g., "Vintage Botanical Mushroom Shirt, Cottagecore Nature Lover Tee, Retro Fungi Graphic Top, Wild Mushroom Illustration Gift").
- Front-load the most descriptive keyword phrase in the first 30 characters.
- No punctuation spam, all-caps shouting, or trademarked brand names.

CATEGORY:
- Suggested Etsy taxonomy breadcrumb path for apparel / print on demand merchandise (e.g., "Clothing > Unisex Adult Clothing > Tops & Tees > T-shirts" or "Art & Collectibles > Prints > Digital Prints").

ATTRIBUTES:
- primaryColor: Dominant palette color (e.g., "Black", "White", "Earth Tones", "Pastel").
- style: Dominant art style (e.g., "Vintage", "Boho", "Minimalist", "Retro 70s", "Y2K", "Gothic").
- occasion: Most fitting event (e.g., "Birthday", "Everyday", "Holiday", "Mother's Day", "Christmas").
- recipient: Primary target audience (e.g., "Unisex Adult", "Women", "Men", "Plant Lovers", "Mom", "Teachers").
- graphic: Brief 2-4 word description of the graphic (e.g., "Vintage Mushroom Illustration").

TAGS:
- EXACTLY 13 distinct tags.
- Maximum 20 characters per tag (Etsy tag character limit).
- Multi-word search phrases (long-tail keywords) preferred over single generic words (e.g., "cottagecore shirt", "mushroom lover gift", "vintage fungi art", "nature graphic tee", "botanical crewneck").
- Do not duplicate words across tags unnecessarily.
- Strictly lowercase, no punctuation, no hashtags.

DESCRIPTION:
- Engaging, professional POD product description formatted with clear sections:
  1. Catchy opening hook highlighting the artwork theme and aesthetic.
  2. Features & Material Details (Soft premium cotton feel, vibrant durable DTG print, classic unisex fit).
  3. Sizing & Fit guidance (Runs true to size, size up for oversized streetwear look).
  4. Care Instructions (Machine wash cold inside out, tumble dry low or hang dry).
  5. Great gift ideas and styling suggestions.

SAFETY & COMPLIANCE:
- Zero famous trademarked characters, celebrities, copyrighted lyrics, or big brand names.
- Trademark safe: true.

Return ONLY valid raw JSON without markdown commentary.
`;

export function buildEtsyPrompt({ referenceData = "", imageContext = "" } = {}) {
  const refBlock = referenceData.trim()
    ? `REFERENCE DATA:\n${referenceData.trim()}`
    : "REFERENCE DATA: none provided";

  const visBlock = imageContext.trim()
    ? `VISUAL INSPECTION:\n${imageContext.trim()}`
    : "VISUAL INSPECTION: inspect the attached design carefully.";

  return `${RULES}\n\n${refBlock}\n\n${visBlock}`.trim();
}
