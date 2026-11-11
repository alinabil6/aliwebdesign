// Magic Listing — Standalone Social Media SEO Prompt
// Completely brand-neutral and dynamically scoped to active channels only.

export function buildSocialListingPrompt({
  matchedRef = null,
  catalogText = "",
  rawNotes = "",
  imageContext = "",
  selectedPlatforms = ["instagram", "facebook", "pinterest", "tiktok"],
  customStoreUrl = "",
  customBrandHandle = "",
} = {}) {
  const activePlatforms = Array.isArray(selectedPlatforms) && selectedPlatforms.length > 0
    ? selectedPlatforms.map((p) => String(p || "").toLowerCase().trim()).filter(Boolean)
    : ["instagram", "facebook", "pinterest", "tiktok"];

  const cleanHandle = String(customBrandHandle || "").trim();
  const handleSuffix = cleanHandle ? ` (${cleanHandle.startsWith("@") ? cleanHandle : `@${cleanHandle}`})` : "";
  const defaultCta = `Shop the collection — Link in Bio!${handleSuffix}`;
  const storeLink = String(customStoreUrl || "").trim() || "https://yourstore.com";

  const channelSpecLines = [];
  const jsonShapeParts = [
    `  "title": "Exact printed quote or core design theme on the shirt (max 45 chars, no hashtags)",`,
    `  "file_name": "lowercase_snake_case_quote.mp4",`,
    `  "summary": "1 concise sentence describing this exact shirt design and angle",`,
    `  "target_audience": "Specific target buyer/viewer persona for this exact design",`,
  ];

  if (activePlatforms.includes("instagram")) {
    channelSpecLines.push(
      `- INSTAGRAM: Write "instagram.caption" (150-250 chars capturing the humor/vibe of THIS specific shirt), "instagram.hashtags" (8-10 space-separated niche hashtags specific to THIS design), and "instagram.call_to_action" ("${defaultCta}").`
    );
    jsonShapeParts.push(
      `  "instagram": {`,
      `    "caption": "150-250 chars tailored strictly to this shirt's exact text/artwork",`,
      `    "hashtags": "#nichetag1 #nichetag2 #funnytees #graphicshirt #moodtag",`,
      `    "call_to_action": "${defaultCta}"`,
      `  },`
    );
  }

  if (activePlatforms.includes("facebook")) {
    channelSpecLines.push(
      `- FACEBOOK: Write "facebook.caption" (conversational, relatable question/hook tailored strictly to THIS shirt so viewers tag friends/comment), "facebook.hashtags" (5-8 relevant hashtags), and "facebook.call_to_action" ("${defaultCta}").`
    );
    jsonShapeParts.push(
      `  "facebook": {`,
      `    "caption": "Engaging conversational hook + question tailored to this exact shirt",`,
      `    "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6",`,
      `    "call_to_action": "${defaultCta}"`,
      `  },`
    );
  }

  if (activePlatforms.includes("pinterest")) {
    channelSpecLines.push(
      `- PINTEREST: Write "pinterest.pin_title" (max 100 chars, combining this exact shirt quote/subject + apparel search terms), "pinterest.pin_description" (200-450 chars keyword-rich SEO description + CTA), "pinterest.board_name" (best matching niche board name for THIS design, e.g. "Sarcastic Quotes & Humor Tees", "Coffee & Introvert Shirts", "Workplace Humor Apparel", "Retro & Vintage Graphic Tees"), "pinterest.destination_link" ("${storeLink}"), "pinterest.tags" (8-10 comma-separated Pinterest search keywords matching THIS shirt), and "pinterest.status" ("READY").`
    );
    jsonShapeParts.push(
      `  "pinterest": {`,
      `    "pin_title": "Quote or Design Title | Niche Graphic Tee",`,
      `    "pin_description": "200-450 chars SEO description strictly about this exact shirt design with a call to action.",`,
      `    "board_name": "Matching niche board name",`,
      `    "destination_link": "${storeLink}",`,
      `    "tags": "keyword 1, keyword 2, keyword 3, keyword 4, keyword 5, keyword 6, keyword 7, keyword 8",`,
      `    "status": "READY"`,
      `  },`
    );
  }

  if (activePlatforms.includes("tiktok")) {
    channelSpecLines.push(
      `- TIKTOK: Write "tiktok.video_title" (scroll-stopping hook max 48 chars for THIS shirt), "tiktok.caption" (100-220 chars TikTok FYP caption tailored to THIS shirt with an engaging prompt + link-in-bio CTA), "tiktok.on_screen_hook" (3-6 word bold text overlay for opening 2 seconds), "tiktok.sound_vibe" (specific trending audio vibe fitting THIS shirt's humor/mood), "tiktok.hashtags" (5-8 targeted TikTok hashtags starting with #fyp), "tiktok.call_to_action" ("Tap link in bio to shop!${handleSuffix}"), and "tiktok.status" ("READY").`
    );
    jsonShapeParts.push(
      `  "tiktok": {`,
      `    "video_title": "Scroll-stopping title for this shirt (max 48 chars)",`,
      `    "caption": "100-220 chars FYP caption about THIS exact shirt design + question + bio CTA",`,
      `    "on_screen_hook": "3-6 word opening hook",`,
      `    "sound_vibe": "Matching audio vibe description",`,
      `    "hashtags": "#fyp #graphictee #nichetag1 #nichetag2 #nichetag3",`,
      `    "call_to_action": "Tap link in bio to shop!${handleSuffix}",`,
      `    "status": "READY"`,
      `  },`
    );
  }

  // Remove trailing comma on last JSON key for strict example clarity
  if (jsonShapeParts.length > 0) {
    jsonShapeParts[jsonShapeParts.length - 1] = jsonShapeParts[jsonShapeParts.length - 1].replace(/,\s*$/, "");
  }

  const refSections = [];
  if (matchedRef) {
    refSections.push(
      `EXACT MATCHED REFERENCE FOR THIS DESIGN (filename matched):\n- Title/Quote: ${matchedRef.title || "(none)"}\n${matchedRef.tags ? `- Tags/Keywords: ${matchedRef.tags}\n` : ""}${matchedRef.description ? `- Notes: ${matchedRef.description}` : ""}`.trim()
    );
  } else if (catalogText) {
    refSections.push(
      `OPTIONAL CSV REFERENCE CATALOG (ONLY use the entry that genuinely matches the text/artwork visible on THIS image; if none match this image, ignore this list completely):\n${catalogText}`
    );
  } else if (rawNotes) {
    refSections.push(`USER NICHE KEYWORDS / NOTES:\n${rawNotes}`);
  } else {
    refSections.push(`USER REFERENCE DATA: None. Inspect ONLY the attached image.`);
  }

  const cleanContext = imageContext && !/(?:library-[a-f0-9]+|[a-f0-9]{8,}|mockup|screenshot|dsc_?\d+|img_?\d+)/i.test(imageContext)
    ? `IMAGE FILENAME HINT: ${imageContext.trim()}`
    : "";

  return `You are a specialist Print-on-Demand Social Media Copywriter & Vision Analyst.

TASK:
1. INSPECT THE ATTACHED IMAGE FIRST. Carefully read the EXACT quote, typography, joke, or illustration printed on the t-shirt/graphic (ignore the model's face, background room, table, or mockup styling).
2. The actual printed quote/subject on THIS shirt is your SINGLE source of truth. Never substitute an unrelated quote, person, or pet joke not present on THIS shirt.
3. Never write e-commerce garment specs (no "100% cotton", "ringspun", "breathable fabric", "double-needle stitching").
4. Never output generic UUIDs, raw file hashes, or placeholder names as the title.
${cleanHandle ? `5. Use this brand handle when writing CTAs: ${cleanHandle.startsWith("@") ? cleanHandle : `@${cleanHandle}`}` : "5. Keep brand references neutral (no invented store names or unrequested @handles)."}
6. Output ONLY a single valid JSON object (no markdown fences, no commentary) containing ONLY the active channels listed below.

ACTIVE CHANNELS (${activePlatforms.map((p) => p.toUpperCase()).join(", ")}):
${channelSpecLines.join("\n")}

${refSections.join("\n\n")}
${cleanContext ? `\n${cleanContext}` : ""}

REQUIRED JSON FORMAT:
{
${jsonShapeParts.join("\n")}
}`.trim();
}
