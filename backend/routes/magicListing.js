import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { withAbs } from '../lib/accounts.js';
import { getProfilePage, canLaunchBrowser } from '../lib/browser.js';
import { MOCK_GEMINI } from '../lib/gemini.js';
import * as web from '../lib/geminiweb.js';
import {
  appendTaxonomyAuditLog,
  claimNextReadyAccount,
  createListingReviewSession,
  recordGeneration,
  setAccountStatus,
  upsertListingFieldReview,
} from '../lib/db.js';
import {
  buildMagicListingPrompt,
  buildTeePublicPrompt,
  buildEtsyPrompt,
} from '../prompts/magicListing.js';
import {
  extractJSON,
  normalizeAiListingContract,
  sanitizeReference,
} from '../lib/magicListingContract.js';

const router = Router();

function buildFallbackRawListing(fileName, platform) {
  const base = String(fileName || 'Original Graphic Artwork')
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Original Graphic Artwork';

  return {
    suggested_title: `${base} Listing Draft`,
    suggested_category: platform === 'etsy' ? 'Digital Art / Print-on-Demand Graphic' : 'Graphic Illustration / Print Design',
    suggested_price_range: platform === 'teepublic'
      ? { min: 22, max: 28, currency: 'USD', label: '$22.00–$28.00' }
      : platform === 'etsy'
        ? { min: 21.99, max: 31.99, currency: 'USD', label: '$21.99–$31.99' }
        : { min: 24.99, max: 29.99, currency: 'USD', label: '$24.99–$29.99' },
    bullet_points: [
      'Fallback draft generated because model output was unavailable or invalid.',
      'Manual review is recommended before exporting or publishing this listing.',
    ],
    confidence_score: 0.28,
    requires_manual_review: true,
    source: 'fallback',
    grounding_notes: [
      'Visual payload could not be converted into a trusted model response.',
      'A conservative fallback template was returned to preserve workflow continuity.',
    ],
    description: `${base} listing draft created from fallback logic. Verify the subject, mood, and audience before publishing.`,
    trademark_safe: true,
  };
}

async function acquireListingAccount(timeoutMs = 60000, excludeIds = []) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const claimed = claimNextReadyAccount(excludeIds);
    if (claimed) return withAbs(claimed);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('All Gemini accounts are busy — try again in a moment');
}

function persistListingReview({ sessionId, designIndex, fileName, platform, contract, rawModelOutput, userId }) {
  createListingReviewSession({
    sessionId,
    designIndex,
    fileName,
    platform,
    source: contract.source,
    confidenceScore: contract.confidence_score,
    requiresManualReview: contract.requires_manual_review,
    rawModelOutput,
    normalizedPayload: contract,
    platformPayload: contract.platform_payload,
    createdBy: userId || null,
  });

  upsertListingFieldReview({
    sessionId,
    fieldName: 'suggested_title',
    aiValue: contract.suggested_title,
    acceptedValue: contract.suggested_title,
    status: 'suggested',
    reviewedBy: userId || null,
  });
  upsertListingFieldReview({
    sessionId,
    fieldName: 'suggested_category',
    aiValue: contract.suggested_category,
    acceptedValue: contract.suggested_category,
    status: 'suggested',
    reviewedBy: userId || null,
  });
  upsertListingFieldReview({
    sessionId,
    fieldName: 'suggested_price_range',
    aiValue: contract.suggested_price_range,
    acceptedValue: contract.suggested_price_range,
    status: 'suggested',
    reviewedBy: userId || null,
  });
  upsertListingFieldReview({
    sessionId,
    fieldName: 'bullet_points',
    aiValue: contract.bullet_points,
    acceptedValue: contract.bullet_points,
    status: 'suggested',
    reviewedBy: userId || null,
  });
}

async function processListingOnAccount(account, design, referenceData, platform, userId, signal = null) {
  const plat = String(platform || 'amazon').toLowerCase();
  const { imageBase64 = '', fileName = '', designIndex = 0 } = design || {};
  const sessionId = uuidv4();
  const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, '');
  const hasVision = Boolean(base64Data);
  const imagePath = path.join(os.tmpdir(), `magic-listing-${uuidv4().slice(0, 8)}.png`);
  let rawModelOutput = '';

  if (hasVision) {
    fs.writeFileSync(imagePath, Buffer.from(base64Data, 'base64'));
  }

  try {
    let parsed = null;
    let usedFallback = false;

    if (MOCK_GEMINI || !canLaunchBrowser(account.browser)) {
      usedFallback = true;
    } else {
      const page = await getProfilePage(account);
      const prompt = plat === 'etsy'
        ? buildEtsyPrompt({ referenceData, imageContext: `Design index ${designIndex}: ${fileName}` })
        : plat === 'teepublic'
          ? buildTeePublicPrompt({ referenceData, imageContext: `Design index ${designIndex}: ${fileName}` })
          : buildMagicListingPrompt({ referenceData, imageContext: `Design index ${designIndex}: ${fileName}` });

      rawModelOutput = await Promise.race([
        web.generateText({
          prompt,
          imagePaths: hasVision ? [imagePath] : [],
          page,
          signal,
          timeoutMs: 65000,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('MAGIC_LISTING_TIMEOUT')), 75000)),
      ]);
      parsed = extractJSON(rawModelOutput);
      usedFallback = !parsed;
    }

    recordGeneration(account.id);
    const contract = normalizeAiListingContract({
      raw: parsed || buildFallbackRawListing(fileName, plat),
      fileName,
      referenceData,
      platform: plat,
      usedVision: hasVision,
      usedFallback,
    });

    persistListingReview({ sessionId, designIndex, fileName, platform: plat, contract, rawModelOutput, userId });

    return {
      success: true,
      sessionId,
      fileName: fileName || `Design #${designIndex}`,
      designIndex,
      platform: plat,
      listing: contract,
    };
  } finally {
    setAccountStatus(account.id, 'ready');
    try {
      fs.rmSync(imagePath, { force: true });
    } catch {}
  }
}

router.post('/review', async (req, res) => {
  try {
    const userId = req.userContext?.userId || req.headers['x-user-id'] || null;
    const payloads = Array.isArray(req.body?.reviews) ? req.body.reviews : [req.body];
    const saved = payloads.map((review) => {
      const sessionId = String(review.sessionId || '').trim();
      const fieldName = String(review.fieldName || '').trim();
      if (!sessionId || !fieldName) {
        throw Object.assign(new Error('sessionId and fieldName are required'), { status: 400 });
      }
      const row = upsertListingFieldReview({
        sessionId,
        fieldName,
        aiValue: review.aiValue,
        acceptedValue: review.acceptedValue,
        status: review.status || 'edited',
        reviewedBy: userId || null,
      });
      appendTaxonomyAuditLog({
        subjectType: 'listing_review_field',
        subjectKey: `${sessionId}:${fieldName}`,
        oldValue: review.aiValue,
        newValue: review.acceptedValue,
        action: review.status || 'edited',
        actorId: userId || null,
        metadata: { platform: review.platform || null },
      });
      return row;
    });

    res.json({ success: true, saved });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not persist review changes' });
  }
});

router.post('/generate', async (req, res) => {
  let account = null;
  try {
    const { imageBase64 = '', referenceData = '', designIndex = 0, fileName = '', platform = 'amazon' } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });
    account = await acquireListingAccount(45000);
    const result = await processListingOnAccount(
      account,
      { imageBase64, fileName, designIndex },
      sanitizeReference(referenceData),
      platform,
      req.userContext?.userId,
    );
    res.json(result);
  } catch (err) {
    if (err.message === 'MAGIC_LISTING_TIMEOUT') {
      return res.status(504).json({ error: 'Listing generation timed out. Browser released.' });
    }
    res.status(500).json({ error: err.message || 'Magic Listing backend processing failed' });
  } finally {
    if (account) setAccountStatus(account.id, 'ready');
  }
});

router.post('/batch', async (req, res) => {
  try {
    const { designs = [], referenceData = '', platform = 'amazon' } = req.body || {};
    if (!Array.isArray(designs) || designs.length === 0) {
      return res.status(400).json({ error: 'designs array is required' });
    }

    const sanitizedReference = sanitizeReference(referenceData);
    let nextIndex = 0;
    const results = [];
    const failed = [];
    const workerCount = Math.min(designs.length, 4);

    async function worker() {
      while (nextIndex < designs.length) {
        const currentIndex = nextIndex++;
        const design = designs[currentIndex];
        let account = null;
        try {
          account = await acquireListingAccount(60000);
          const result = await processListingOnAccount(
            account,
            design,
            sanitizedReference,
            platform,
            req.userContext?.userId,
          );
          results.push(result);
        } catch (err) {
          failed.push({
            designIndex: design?.designIndex ?? currentIndex + 1,
            fileName: design?.fileName || `Design #${currentIndex + 1}`,
            error: err.message === 'MAGIC_LISTING_TIMEOUT'
              ? 'Listing generation timed out. Browser released.'
              : (err.message || 'This design could not be processed.'),
          });
        } finally {
          if (account) setAccountStatus(account.id, 'ready');
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    results.sort((a, b) => (a.designIndex ?? 0) - (b.designIndex ?? 0));
    res.json({ success: true, results, failed, total: designs.length });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Magic Listing batch processing failed' });
  }
});

export default router;
