import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAiListingContract, sanitizeReference } from '../../backend/lib/magicListingContract.js';

test('sanitizeReference trims and normalizes whitespace', () => {
  assert.equal(sanitizeReference(' hello\n\nworld\t  '), 'hello world');
});

test('normalizeAiListingContract returns normalized review contract', () => {
  const result = normalizeAiListingContract({
    raw: {
      suggested_title: 'Forest Moon Wolves Poster',
      suggested_category: 'Nature / Wildlife Illustration',
      suggested_price_range: { min: 25, max: 30, currency: 'USD', label: '$25-$30' },
      bullet_points: ['Grounded in visible moonlit wolves.', 'Reference notes matched the visible wildlife theme.'],
      confidence_score: 0.88,
      requires_manual_review: false,
      grounding_notes: ['Visible wolves and moon imagery were used.'],
      description: 'A moody wildlife composition with clean contrast.',
      trademark_safe: true,
    },
    fileName: 'forest-wolf.png',
    referenceData: 'wildlife, moon, forest',
    platform: 'amazon',
    usedVision: true,
    usedFallback: false,
  });

  assert.equal(result.suggested_title, 'Forest Moon Wolves Poster');
  assert.equal(result.suggested_category, 'Nature / Wildlife Illustration');
  assert.equal(result.platform_payload.title, 'Forest Moon Wolves Poster');
  assert.equal(result.requires_manual_review, false);
  assert.equal(result.source, 'vision+reference');
  assert.ok(Array.isArray(result.bullet_points));
});

test('fallback path forces manual review and fallback source', () => {
  const result = normalizeAiListingContract({
    raw: {},
    fileName: 'fallback.png',
    referenceData: '',
    platform: 'etsy',
    usedVision: false,
    usedFallback: true,
  });
  assert.equal(result.source, 'fallback');
  assert.equal(result.requires_manual_review, true);
  assert.ok(result.confidence_score <= 0.32);
});
