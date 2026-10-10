const DEFAULT_PRICE_RANGES = {
  amazon: { min: 24.99, max: 29.99, currency: 'USD' },
  teepublic: { min: 22, max: 28, currency: 'USD' },
  etsy: { min: 21.99, max: 31.99, currency: 'USD' },
};

const BANNED_TERMS_RE = /\b(?:shirt|tee|t-?shirt|gift|gifts|present|merch|clothes|apparel)\b/gi;

export function sanitizeReference(referenceData) {
  return String(referenceData || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 2000)
    .trim();
}

export function sanitizeCopy(text) {
  return String(text ?? '')
    .replace(BANNED_TERMS_RE, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateAtWord(text, maxLen) {
  const s = String(text ?? '').trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

export function extractJSON(rawText) {
  if (!rawText) return null;
  let clean = String(rawText).replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) clean = match[0];
  try {
    return JSON.parse(clean);
  } catch {
    const grabString = (aliases) => {
      for (const alias of aliases) {
        const m = clean.match(new RegExp(`"${alias}"\\s*:\\s*"([^"]+)"`, 'i'));
        if (m) return m[1];
      }
      return '';
    };
    const grabBool = (aliases) => {
      for (const alias of aliases) {
        const m = clean.match(new RegExp(`"${alias}"\\s*:\\s*(true|false)`, 'i'));
        if (m) return m[1].toLowerCase() === 'true';
      }
      return null;
    };
    const grabNumber = (aliases) => {
      for (const alias of aliases) {
        const m = clean.match(new RegExp(`"${alias}"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, 'i'));
        if (m) return Number(m[1]);
      }
      return null;
    };
    const grabArray = (aliases) => {
      for (const alias of aliases) {
        const m = clean.match(new RegExp(`"${alias}"\\s*:\\s*\\[([^\\]]*)\\]`, 'i'));
        if (m) return [...m[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]);
      }
      return [];
    };

    const title = grabString(['suggested_title', 'title']);
    const category = grabString(['suggested_category', 'category']);
    const priceLabel = grabString(['suggested_price_range', 'price_range']);
    const description = grabString(['description', 'desc']);
    const source = grabString(['source']);
    const bulletPoints = grabArray(['bullet_points', 'bullets', 'supporting_tags', 'tags']);
    const groundingNotes = grabArray(['grounding_notes']);
    const confidenceScore = grabNumber(['confidence_score']);
    const requiresManualReview = grabBool(['requires_manual_review']);
    const brand = grabString(['brand', 'brand_name', 'brandName']);
    const bullet1 = grabString(['bullet1', 'bullet_1']);
    const bullet2 = grabString(['bullet2', 'bullet_2']);
    const mainTag = grabString(['main_tag', 'mainTag', 'primary_tag']);
    const supportingTags = grabArray(['supporting_tags', 'supportingTags']);

    if (!title && !category && !description && bulletPoints.length === 0 && !mainTag) return null;

    return {
      suggested_title: title,
      suggested_category: category,
      suggested_price_range: priceLabel,
      bullet_points: bulletPoints.length ? bulletPoints : [bullet1, bullet2].filter(Boolean),
      confidence_score: confidenceScore,
      requires_manual_review: requiresManualReview,
      source,
      grounding_notes: groundingNotes,
      description,
      brand,
      main_tag: mainTag,
      supporting_tags: supportingTags,
      trademark_safe: true,
    };
  }
}

function compactArray(values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

function toTitleCase(value) {
  return String(value || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parsePriceRange(rawValue, platform = 'amazon') {
  const fallback = DEFAULT_PRICE_RANGES[platform] || DEFAULT_PRICE_RANGES.amazon;
  if (!rawValue) {
    return {
      ...fallback,
      label: `$${fallback.min.toFixed(2)}–$${fallback.max.toFixed(2)}`,
    };
  }

  if (typeof rawValue === 'object' && rawValue !== null) {
    const min = Number(rawValue.min ?? rawValue.low ?? fallback.min);
    const max = Number(rawValue.max ?? rawValue.high ?? fallback.max);
    const currency = String(rawValue.currency || fallback.currency || 'USD');
    return {
      min: Number.isFinite(min) ? min : fallback.min,
      max: Number.isFinite(max) ? max : fallback.max,
      currency,
      label: rawValue.label || `$${(Number.isFinite(min) ? min : fallback.min).toFixed(2)}–$${(Number.isFinite(max) ? max : fallback.max).toFixed(2)}`,
    };
  }

  const numbers = String(rawValue).match(/[0-9]+(?:\.[0-9]+)?/g)?.map(Number) || [];
  const min = Number.isFinite(numbers[0]) ? numbers[0] : fallback.min;
  const max = Number.isFinite(numbers[1]) ? numbers[1] : (Number.isFinite(numbers[0]) ? numbers[0] + 5 : fallback.max);
  return {
    min,
    max,
    currency: fallback.currency,
    label: String(rawValue).trim() || `$${min.toFixed(2)}–$${max.toFixed(2)}`,
  };
}

function computeSource({ usedVision, usedReference, usedFallback }) {
  if (usedFallback) return 'fallback';
  if (usedVision && usedReference) return 'vision+reference';
  if (usedVision) return 'vision';
  if (usedReference) return 'reference';
  return 'fallback';
}

function computeConfidence({ usedVision, usedReference, usedFallback, parsedConfidence }) {
  if (typeof parsedConfidence === 'number' && Number.isFinite(parsedConfidence)) {
    return Math.max(0, Math.min(1, parsedConfidence));
  }
  if (usedFallback) return 0.28;
  if (usedVision && usedReference) return 0.82;
  if (usedVision) return 0.74;
  if (usedReference) return 0.56;
  return 0.32;
}

function deriveCategory(parsed, platform, fileName) {
  if (parsed?.suggested_category) return truncateAtWord(parsed.suggested_category, 80);
  if (parsed?.category) return truncateAtWord(parsed.category, 80);
  const base = fileName ? fileName.replace(/\.[^/.]+$/, '').replace(/[-_]+/g, ' ') : 'Graphic Art';
  if (platform === 'etsy') return 'Digital Art / Print-on-Demand Graphic';
  if (platform === 'teepublic') return `${truncateAtWord(base, 40)} / Graphic Illustration`;
  return `${truncateAtWord(base, 40)} / Print Graphic`;
}

function deriveTitle(parsed, fileName) {
  const raw = parsed?.suggested_title || parsed?.title || fileName?.replace(/\.[^/.]+$/, '').replace(/[-_]+/g, ' ') || 'Original Graphic Artwork';
  return truncateAtWord(sanitizeCopy(raw), 120);
}

function deriveDescription(parsed, title, bulletPoints) {
  const raw = parsed?.description || parsed?.desc || '';
  if (raw) return truncateAtWord(raw.replace(/[\r\n\t]+/g, ' '), 700);
  const fallback = `${title}. ${bulletPoints.slice(0, 2).join(' ')}`.trim();
  return truncateAtWord(fallback, 500);
}

function deriveBulletPoints(parsed, title, category) {
  const raw = compactArray([
    parsed?.bullet_points,
    parsed?.bullets,
    parsed?.bullet1,
    parsed?.bullet_1,
    parsed?.bullet2,
    parsed?.bullet_2,
  ]);
  if (raw.length >= 2) return raw.slice(0, 4).map((point) => truncateAtWord(point, 180));
  return [
    truncateAtWord(`Grounded in the uploaded design and focused on ${category.toLowerCase()}.`, 180),
    truncateAtWord(`Uses a clean marketplace framing for ${title.toLowerCase()} without unsupported claims.`, 180),
  ];
}

function buildKeywordSeed(title, category, bulletPoints) {
  return compactArray([title, category, bulletPoints.join(' ')])
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 12);
}

function buildAmazonPayload(contract, parsed = {}) {
  const title = truncateAtWord(contract.suggested_title, 60);
  const brand = truncateAtWord(sanitizeCopy(parsed.brand || `${contract.suggested_category.split('/')[0] || 'Aliwebdesign'} Studio`), 50);
  const bullet1 = truncateAtWord(contract.bullet_points[0] || `Design-forward listing for ${contract.suggested_category}.`, 256);
  const bullet2 = truncateAtWord(contract.bullet_points[1] || `Manual review ${contract.requires_manual_review ? 'recommended' : 'optional'} before publish.`, 256);
  return {
    title,
    brand,
    bullet1,
    bullet2,
    description: truncateAtWord(contract.description, 500),
    trademark_safe: contract.trademark_safe,
  };
}

function buildTeePublicPayload(contract, parsed = {}) {
  const seed = buildKeywordSeed(contract.suggested_title, contract.suggested_category, contract.bullet_points);
  const mainTag = truncateAtWord(sanitizeCopy(parsed.main_tag || seed.slice(0, 2).join(' ') || contract.suggested_category.split('/')[0] || 'graphic art'), 20).toLowerCase();
  const supportingTags = compactArray([
    parsed.supporting_tags,
    seed.slice(1, 8),
    contract.bullet_points.map((p) => p.split(' ').slice(0, 3).join(' ')),
  ])
    .map((tag) => truncateAtWord(sanitizeCopy(tag).toLowerCase(), 20))
    .filter((tag) => tag && tag !== mainTag)
    .filter((tag, index, list) => list.indexOf(tag) === index)
    .slice(0, 10);
  return {
    title: truncateAtWord(contract.suggested_title, 80),
    description: truncateAtWord(contract.description, 300),
    main_tag: mainTag,
    supporting_tags: supportingTags,
    trademark_safe: contract.trademark_safe,
  };
}

function buildEtsyPayload(contract, parsed = {}) {
  const seed = buildKeywordSeed(contract.suggested_title, contract.suggested_category, contract.bullet_points);
  const tags = compactArray([parsed.tags, parsed.supporting_tags, seed, contract.bullet_points.map((p) => p.split(' ').slice(0, 3).join(' '))])
    .map((tag) => truncateAtWord(sanitizeCopy(tag).toLowerCase(), 20))
    .filter(Boolean)
    .filter((tag, index, list) => list.indexOf(tag) === index)
    .slice(0, 13);
  return {
    title: truncateAtWord(contract.suggested_title, 140),
    category: truncateAtWord(contract.suggested_category || 'Digital Art / Print-on-Demand Graphic', 100),
    attributes: {
      primaryColor: 'Black',
      style: toTitleCase(seed[0] || 'illustrated graphic'),
      occasion: contract.requires_manual_review ? 'Review before publish' : 'Everyday',
      recipient: 'Unisex Adult',
      graphic: toTitleCase(seed.slice(0, 2).join(' ') || 'Graphic Illustration'),
    },
    tags,
    description: truncateAtWord(contract.description, 1500),
    trademark_safe: contract.trademark_safe,
  };
}

export function buildPlatformPayload(contract, parsed = {}, platform = 'amazon') {
  const plat = String(platform || 'amazon').toLowerCase();
  if (plat === 'etsy') return buildEtsyPayload(contract, parsed);
  if (plat === 'teepublic') return buildTeePublicPayload(contract, parsed);
  return buildAmazonPayload(contract, parsed);
}

export function normalizeAiListingContract({ raw, fileName = '', referenceData = '', platform = 'amazon', usedVision = true, usedFallback = false } = {}) {
  const parsed = typeof raw === 'object' && raw !== null ? raw : {};
  const title = deriveTitle(parsed, fileName);
  const category = deriveCategory(parsed, platform, fileName);
  const bulletPoints = deriveBulletPoints(parsed, title, category);
  const priceRange = parsePriceRange(parsed.suggested_price_range || parsed.price_range, platform);
  const description = deriveDescription(parsed, title, bulletPoints);
  const source = computeSource({ usedVision, usedReference: Boolean(referenceData), usedFallback });
  const confidenceScore = computeConfidence({ usedVision, usedReference: Boolean(referenceData), usedFallback, parsedConfidence: parsed.confidence_score });
  const groundingNotes = compactArray([
    parsed.grounding_notes,
    usedVision ? 'Visual payload was supplied to the listing engine.' : 'No visual payload was available.',
    referenceData ? 'Reference notes were used as supporting context.' : 'No reference notes were supplied.',
    usedFallback ? 'Fallback normalization was used because the model output was unavailable or invalid.' : 'Model output was normalized into the review contract.',
  ]).slice(0, 6);

  const contract = {
    suggested_title: title,
    suggested_category: category,
    suggested_price_range: priceRange,
    bullet_points: bulletPoints,
    confidence_score: Number(confidenceScore.toFixed(2)),
    requires_manual_review: parsed.requires_manual_review ?? (confidenceScore < 0.65),
    source,
    grounding_notes: groundingNotes,
    description,
    trademark_safe: parsed.trademark_safe !== false,
  };

  contract.platform_payload = buildPlatformPayload(contract, parsed, platform);
  return contract;
}
