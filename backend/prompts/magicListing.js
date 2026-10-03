// Magic Listing prompts
// Amazon Merch on Demand + TeePublic
// Conservative SEO: strong relevance, natural language, minimal keyword stuffing.

const FILTERED_TERMS =
    "shirt, tee, t-shirt, gift, gifts, present, merch, clothes, apparel";

const RULES = `
Generate an accurate, natural Amazon Merch on Demand listing for ONLY the provided design.

INPUT:
1. REFERENCE DATA: optional keywords, niche information, or research data.
2. VISUAL INSPECTION: the uploaded design or reliable visual notes.

FIRST identify:
- exact subject
- primary theme
- visual style
- text or message, if present
- strongest buyer search intent

SEO STRATEGY:
Prioritize relevance and natural language over keyword volume.

KEYWORD SELECTION:
- Select ONE primary search phrase.
- Select at most TWO closely related secondary terms.
- Use selected terms only where they naturally fit.
- Do not force keywords into sentences.
- Do not repeat the same keyword unnecessarily.
- Never use a reference keyword merely because it was provided.
- Exclude terms that are unrelated, ambiguous, risky, or unsupported by the design.

LISTING QUALITY:
Write concise copy that sounds like a human marketplace copywriter.
Every statement must describe the actual design.
Do not invent subjects, themes, audiences, occasions, or features.

JSON FORMAT:
{
  "title": "string", (STRICT: Max 60 characters total. Never include banned words: "shirt", "t-shirt", "gift", "hoodie", or "apparel".)
  "brand": "string",
  "bullet1": "string",
  "bullet2": "string",
  "description": "string"
}

TITLE:
- Maximum 60 characters.
- Lead with the primary search phrase when natural.
- Clearly describe the actual design.
- No keyword chains or repeated keyword variations.
- No hyphens or underscores.
- Do not add generic product terms.

BRAND:
- Required and maximum 50 characters.
- Use a simple original niche brand label relevant to the design.
- Do not use existing brands, companies, celebrities, franchises, organizations, or trademark-like names.
- Do not turn the brand into a keyword list.

BULLET 1:
- Maximum 256 characters.
- Describe the main subject, theme, visual style, or message.
- Use the primary keyword naturally when appropriate.
- Keep it concise and do not repeat the title unnecessarily.

BULLET 2:
- Maximum 256 characters.
- Describe the most relevant audience or context only when clearly supported by the design.
- Use no more than one secondary keyword.
- Do not invent a gift occasion just for SEO.

DESCRIPTION:
- Maximum 350 characters.
- Write only 1 or 2 concise sentences.
- Describe the artwork, subject, theme, and visual character.
- Use remaining relevant keywords naturally.
- Do not repeat the title or bullets.
- No filler or generic marketing language.

STRICT SAFETY:
- Never use these words: ${FILTERED_TERMS}.
- No promotional claims such as best, great, perfect, premium, high quality, buy now, discount, or guaranteed.
- No keyword stuffing.
- No keyword lists inside sentences.
- No unrelated search terms.
- No punctuation spam.
- No emojis.
- No brands, franchises, celebrities, fictional characters, song lyrics, or protected slogans unless clearly provided as legally usable content.
- Do not modify or disguise questionable terms to make them appear safe.
- Do not claim that a term has been legally cleared.

DESIGN ISOLATION:
Describe ONLY this design.
Never merge information from multiple designs.
Do not infer a niche from reference data when the visual design does not support it.

FINAL CHECK:
1. Does every statement describe the actual design?
2. Is there exactly one clear primary keyword?
3. Are there no more than two secondary keywords?
4. Does the copy sound natural without the keywords?
5. Did any unrelated or potentially protected term enter the listing?
6. Is every field within its character limit?

Return ONLY valid raw JSON.
`;

export function buildMagicListingPrompt({
    referenceData = "",
    imageContext = ""
} = {}) {
    const refBlock = referenceData.trim()
        ? `REFERENCE DATA:
${referenceData.trim()}`
        : "REFERENCE DATA: none provided";

    const visBlock = imageContext.trim()
        ? `VISUAL INSPECTION:
${imageContext.trim()}`
        : "VISUAL INSPECTION: inspect the attached design carefully.";

    return `${RULES}

${refBlock}

${visBlock}`.trim();
}


// ────────────────────────────────────────────────────────────
// TeePublic — Conservative SEO
// ────────────────────────────────────────────────────────────

const TEEPUBLIC_RULES = `
Generate an accurate, natural TeePublic listing for ONLY the provided design.

INPUT:
1. REFERENCE DATA: optional keywords, niche information, or research data.
2. VISUAL INSPECTION: the uploaded design or reliable visual notes.

SEO STRATEGY:
Prioritize search relevance and natural language over keyword volume.

KEYWORD HIERARCHY:
- MAIN TAG = the single strongest search phrase describing the design.
- SUPPORTING TAGS = only closely related terms supported by the artwork.
- Prefer 6 to 10 strong supporting tags.
- Use fewer tags when fewer relevant terms exist.
- Never create tags just to reach a number.
- Avoid redundant variations of the same keyword.
- Avoid long keyword chains.
- Never add unrelated audience, occasion, trend, or gift keywords.

TITLE:
- Between 40 and 80 characters.
- Clearly describe what the design shows.
- Include the main search phrase naturally.
- Write for a real customer, not a search engine.
- No keyword stacking.
- No hyphens or underscores.

DESCRIPTION:
- Between 150 and 250 characters.
- Write 1 or 2 concise sentences.
- Describe the artwork, subject, theme, and style.
- Naturally use the main concept and, when appropriate, one supporting term.
- No filler or generic marketing language.
- Do not repeat keywords unnecessarily.

MAIN TAG:
- 1 to 3 words.
- Lowercase.
- No punctuation.
- The single most specific search phrase representing the artwork.
- Must accurately describe the actual design.

SUPPORTING TAGS:
- Prefer 6 to 10 tags.
- 1 to 3 words each.
- Lowercase.
- No punctuation.
- Use only relevant subject, theme, style, mood, or audience terms.
- Every tag must add distinct relevance.
- Do not use redundant keyword variations.
- Do not use unrelated search terms.
- Stop when relevant terms run out.

STRICT SAFETY:
- No brands, franchises, celebrities, fictional characters, lyrics, or protected slogans unless clearly provided as legally usable content.
- If a reference keyword appears potentially protected, ambiguous, or unrelated, exclude it.
- Never modify a questionable term to make it appear safer.
- No promotional claims.
- No keyword stuffing.
- No punctuation spam.
- No emojis.
- Do not claim that a term has been legally cleared.

DESIGN ISOLATION:
Describe ONLY the provided design.
Do not combine information from other designs.
Do not invent elements that cannot reasonably be identified.

FINAL QUALITY CHECK:
1. Would a real customer naturally search for these terms?
2. Does every tag accurately describe the artwork?
3. Is the main tag the clearest single concept?
4. Are supporting tags genuinely different from one another?
5. Is the title readable without removing keywords?
6. Is the description concise and useful?
7. Did any unrelated or questionable term enter the listing?

Return ONLY this valid JSON object:

{
  "title": "string",
  "description": "string",
  "main_tag": "string",
  "supporting_tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6"]
}
`;

export function buildTeePublicPrompt({
    referenceData = "",
    imageContext = ""
} = {}) {
    const refBlock = referenceData.trim()
        ? `REFERENCE DATA:
${referenceData.trim()}`
        : "REFERENCE DATA: none provided";

    const visBlock = imageContext.trim()
        ? `VISUAL INSPECTION:
${imageContext.trim()}`
        : "VISUAL INSPECTION: inspect the attached design carefully.";

    return `${TEEPUBLIC_RULES}

${refBlock}

${visBlock}`.trim();
}