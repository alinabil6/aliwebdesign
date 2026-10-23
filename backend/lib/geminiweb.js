import fs from "fs";
import { closeProfile, closeProfileForPage, getAccountIdForPage } from "./browser.js";

export class GenerationTimeoutError extends Error {
  constructor(message = "Per-account generation ceiling exceeded (75s)") {
    super(message);
    this.name = "GenerationTimeoutError";
    this.code = "GENERATION_TIMEOUT";
    this.isTimeout = true;
  }
}

export const HARD_GENERATION_CEILING_MS = 75000; // 75s absolute per-account ceiling

export async function withGenerationCeiling(fn, { page = null, accountId = null, ceilingMs = HARD_GENERATION_CEILING_MS, signal = null } = {}) {
  let timer = null;
  let settled = false;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      const targetId = accountId || getAccountIdForPage(page);
      console.warn(`[geminiweb] Hard generation ceiling breached (${Math.round(ceilingMs / 1000)}s) for ${targetId || "unknown account"}. Closing profile context...`);
      try {
        if (targetId) {
          await closeProfile(targetId);
        } else if (page) {
          await closeProfileForPage(page);
        }
      } catch (closeErr) {
        console.warn("[geminiweb] Error closing profile context on ceiling breach:", closeErr.message);
      }
      reject(new GenerationTimeoutError(`Per-account generation ceiling exceeded (${Math.round(ceilingMs / 1000)}s)${targetId ? ` on ${targetId}` : ""}`));
    }, ceilingMs);
  });

  const fnPromise = (async () => fn())();
  // Absorb background rejection from fnPromise if timeoutPromise wins and tears down the browser,
  // preventing unhandledRejection from crashing the Node.js server.
  fnPromise.catch(() => {});

  try {
    const result = await Promise.race([fnPromise, timeoutPromise]);
    settled = true;
    return result;
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
  }
}

export const GEMINI_URL = "https://gemini.google.com/app";
const GEMINI_HOST = "gemini.google.com";

export const SELECTORS = {
  promptInput: [
    'rich-textarea div[contenteditable="true"]',
    ".ql-editor",
    'div[role="textbox"]',
    'div[contenteditable="true"]',
    "textarea",
  ],
  sendButton: [
    'button[aria-label*="Send message" i]:not([disabled]):not([aria-disabled="true"])',
    'button[aria-label*="Send" i]:not([disabled]):not([aria-disabled="true"])',
    'button[aria-label*="Envoyer" i]:not([disabled]):not([aria-disabled="true"])',
    'button.send-button:not([disabled]):not([aria-disabled="true"])',
    '[data-test-id="send-button"]:not([disabled]):not([aria-disabled="true"])',
  ],
  fileInput: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
  attachButton: [
    'button[aria-label*="Upload & tools" i]',
    'button[aria-label*="Upload and tools" i]',
    'button[aria-label*="Add files" i]',
    'button.menu-placeholder-button',
    'button[aria-label*="Upload" i]:not(nav *):not(aside *)',
    'button[aria-label*="Add" i]:not(nav *):not(aside *)',
    'button:has(mat-icon.upload-icon)',
    'button:has(mat-icon[data-mat-icon-name*="add"]):not(nav *):not(aside *)',
    '[aria-label*="Upload" i]:not(nav *):not(aside *)',
    'mat-icon.upload-icon',
    'mat-icon:has-text("plus")',
  ],
  uploadMenuItem: [
    'text="Upload files"',
    '[data-test-id="local-images-files-upload"]',
    'button[data-test-id*="upload" i]',
    '.gem-menu-item-label:has-text("Upload files")',
    'mat-list-item:has-text("Upload files")',
    'button:has-text("Upload files")',
    '[role="menuitem"]:has-text("Upload files")',
    '[role="menuitem"][aria-label*="Upload files" i]',
    '[aria-label*="Upload files" i]',
  ],
  outputImage: "model-response img, .response-container img, [data-test-id*='response'] img",
  signedInAvatar: ['[aria-label*="Google Account"]', '[aria-label*="@"]', '.gb_A'],
  signInButton: ['a[href*="accounts.google.com"]', 'button:has-text("Sign in")'],
};

export async function findVisibleElement(page, selectors, maxTimeoutMs = 15000) {
  const list = [].concat(selectors);
  const deadline = Date.now() + maxTimeoutMs;
  while (Date.now() < deadline) {
    if (!page || page.isClosed()) throw new Error("Target page, context or browser has been closed");
    for (const sel of list) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const el = loc.nth(i);
          const visible = await el.isVisible().catch(() => false);
          if (visible) return el;
        }
      } catch (_) {}
    }
    await page.waitForTimeout(150);
  }
  return null;
}

async function getVisibleAttachButton(page, maxTimeoutMs = 10000) {
  return findVisibleElement(page, SELECTORS.attachButton, maxTimeoutMs);
}

async function getVisibleUploadItem(page, maxTimeoutMs = 5000) {
  return findVisibleElement(page, SELECTORS.uploadMenuItem, maxTimeoutMs);
}

async function firstVisible(page, candidates, { timeout = 5000 } = {}) {
  return findVisibleElement(page, candidates, timeout);
}

async function dismissModals(page) {
  try {
    const modalSelectors = [
      'button:has-text("Agree")', 'button:has-text("Accept all")', 'button:has-text("Got it")', 'button:has-text("Dismiss")', 'button:has-text("Not now")',
      'button:has-text("I agree")', 'button:has-text("Stay signed out")', 'button:has-text("No thanks")', 'button:has-text("Cancel")', 'button:has-text("Close")',
      'button:has-text("Remind me later")', 'button:has-text("I understand")',
      'button:has-text("J\'accepte")', 'button:has-text("Accepter tout")', 'button:has-text("Tout accepter")', 'button:has-text("Continuer")', 'button:has-text("Plus tard")',
      '[role="dialog"] button[aria-label*="Close" i]', '[role="dialog"] button[aria-label*="Fermer" i]'
    ];
    for (const sel of modalSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  } catch {}
}

const PREVIEW_SELECTOR = ".file-preview, .uploaded-image, mat-chip, [aria-label*='Remove' i], [aria-label*='Supprimer' i], [aria-label*='Delete' i], img[src^='blob:'], img[src^='data:'], input-area-v2 img, input-container img, .uploader-preview, [class*='thumbnail']";

async function waitForAttachmentPreview(page, beforePreviewCount, maxMs = 3000, expectedCount = 1) {
  const loc = page.locator(PREVIEW_SELECTOR);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const n = await loc.count().catch(() => 0);
    if (n >= beforePreviewCount + expectedCount) return true;
    await page.waitForTimeout(100);
  }
  return (await loc.count().catch(() => 0)) > beforePreviewCount;
}

async function waitForUploadCompletion(page, maxMs = 3500) {
  try {
    await page.waitForFunction(() => {
      const uploadSpinners = document.querySelectorAll(
        '.upload-progress, mat-progress-spinner.upload-progress, mat-progress-spinner:not(aside *):not(nav *), [role="progressbar"]:not(aside *):not(nav *)'
      );
      return uploadSpinners.length === 0;
    }, { timeout: maxMs });
  } catch (_) {}
}

async function attachReferenceImages(page, imagePaths, signal = null) {
  if (!imagePaths || imagePaths.length === 0) return;
  if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
  await dismissModals(page);
  const beforePreview = await page.locator(PREVIEW_SELECTOR).count().catch(() => 0);

  // 1. Ensure composer toolbar is mounted
  const editor = await findVisibleElement(page, SELECTORS.promptInput, 15000);
  if (!editor) throw new Error("Gemini composer not ready for image attachment");

  // 2. Direct attach: Check if input[type="file"] is already mounted in DOM
  const fileInputSelector = SELECTORS.fileInput.join(", ");
  let fileInput = page.locator(fileInputSelector).last();
  let count = await fileInput.count().catch(() => 0);

  if (count === 0) {
    console.log("[geminiweb] input[type='file'] not mounted, waiting for attach button...");
    const attachBtn = await getVisibleAttachButton(page, 10000);
    if (attachBtn) {
      await attachBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    fileInput = page.locator(fileInputSelector).last();
    count = await fileInput.count().catch(() => 0);
  }

  // Fallback check if menu item needs to be clicked
  if (count === 0) {
    const uploadItem = await getVisibleUploadItem(page, 4000);
    if (uploadItem) {
      await uploadItem.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    fileInput = page.locator(fileInputSelector).last();
    count = await fileInput.count().catch(() => 0);
  }

  if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

  // 3. Dispatch files to input[type="file"]
  try {
    await fileInput.setInputFiles(imagePaths, { timeout: 8000 });
    console.log(`[geminiweb] Direct setInputFiles dispatched with ${imagePaths.length} file(s)`);
  } catch (err) {
    console.warn("[geminiweb] Direct setInputFiles failed, attempting fallback:", err?.message);
    const fallbackInput = page.locator(fileInputSelector).last();
    await fallbackInput.setInputFiles(imagePaths, { timeout: 8000 });
  }

  // 4. Verify attachment mounted in DOM and wait for upload completion
  const mounted = await waitForAttachmentPreview(page, beforePreview, 8000, imagePaths.length);
  if (!mounted) {
    console.warn("[geminiweb] Attachment preview chip not immediately detected, waiting for upload settling...");
  }
  await waitForUploadCompletion(page, 8000);
  console.log(`[geminiweb] Uploaded ${imagePaths.length} reference image(s)`);
}

async function fillPrompt(page, promptText) {
  const editor = await findVisibleElement(page, SELECTORS.promptInput, 15000);
  if (!editor) throw new Error("Gemini prompt editor not found");
  await editor.click({ timeout: 3000 }).catch(() => {});
  await editor.evaluate((el) => { el.innerHTML = ""; el.focus(); }).catch(() => {});
  await page.keyboard.insertText(promptText);
  await editor.evaluate((el) => {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }).catch(() => {});
  return editor;
}

async function submitPrompt(page, editor) {
  console.log("[geminiweb] Submitting prompt...");
  const uqBefore = await page.locator("user-query, .user-query-container").count().catch(() => 0);
  const mrBefore = await page.locator("model-response").count().catch(() => 0);

  const checkDispatched = () => page.evaluate(({ uqPrev, mrPrev }) => {
    const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], [data-test-id*="stop"]');
    if (stopBtn && window.getComputedStyle(stopBtn).display !== "none" && stopBtn.offsetWidth > 0) return true;
    if (document.querySelectorAll("user-query, .user-query-container").length > uqPrev) return true;
    if (document.querySelectorAll("model-response").length > mrPrev) return true;
    return false;
  }, { uqPrev: uqBefore, mrPrev: mrBefore }).catch(() => false);

  const sendSelector = SELECTORS.sendButton.join(", ");
  const deadline = Date.now() + 20000;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    if (!page || page.isClosed()) throw new Error("Target page, context or browser has been closed");

    // Check if send button is enabled in the DOM
    const isSendReady = await page.evaluate((selectors) => {
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetWidth > 0 && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
          return true;
        }
      }
      return false;
    }, SELECTORS.sendButton).catch(() => false);

    if (isSendReady) {
      const send = page.locator(sendSelector).first();
      await send.click({ timeout: 2000 }).catch(() => {});
    } else {
      await editor.focus().catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    }

    // Poll for dispatch confirmation
    for (let w = 0; w < 6; w++) {
      await page.waitForTimeout(250);
      if (await checkDispatched()) {
        console.log(`[geminiweb] Prompt submitted successfully (confirmed on attempt ${attempts}).`);
        return;
      }
    }

    // Alternative: Enter press
    await editor.focus().catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(350);
    if (await checkDispatched()) {
      console.log(`[geminiweb] Prompt submitted successfully via Enter fallback (attempt ${attempts}).`);
      return;
    }
  }
  console.log("[geminiweb] Prompt submission loop finished.");
}

async function monitorAndExtractOutput(page, beforeCount, timeout = 65000, outputPath = null, signal = null) {
  const start = Date.now();
  const deadline = start + timeout;
  console.log("[geminiweb] Waiting for output image render...");
  const imgLoc = page.locator("model-response img, .response-container img, [data-test-id*='response'] img");
  let streamingDoneStart = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
    }

    const count = await imgLoc.count().catch(() => 0);
    if (count > beforeCount) {
      const target = imgLoc.last();
      const isValid = await target.evaluate((img) => img.complete && img.naturalWidth >= 512).catch(() => false);
      if (isValid) {
        let base64Data = await page.evaluate(async () => {
          const imgs = Array.from(document.querySelectorAll("model-response img, .response-container img"));
          const valid = imgs.filter(i => i.complete && i.naturalWidth >= 512);
          if (valid.length === 0) return null;
          const img = valid[valid.length - 1];
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL("image/png");
            // Free canvas backing store in browser engine immediately
            canvas.width = 0;
            canvas.height = 0;
            canvas.remove();
            return dataUrl.split(",")[1];
          } catch {
            return null;
          }
        }).catch(() => null);

        if (base64Data && base64Data.length > 5000) {
          const buf = Buffer.from(base64Data, "base64");
          base64Data = null; // Immediately nullify multi-megabyte string for V8 GC

          if (outputPath) {
            await fs.promises.writeFile(outputPath, buf);
            console.log(`[geminiweb] evacuated ${buf.length} bytes directly to disk at ${outputPath}`);
          } else {
            console.log(`[geminiweb] captured ${buf.length} bytes via clean in-memory canvas`);
          }

          if (typeof global.gc === "function") {
            try { global.gc(); } catch (_) {}
          }
          return buf;
        }
      }
    }

    // Check if Gemini is actively generating an image or displaying progress
    const isImageInProgress = await page.evaluate(() => {
      const spinners = document.querySelectorAll(
        "model-response mat-spinner, model-response mat-progress-spinner, model-response .loading-indicator, model-response .shimmer, model-response [data-test-id*='image'], model-response [class*='image-loading'], model-response [class*='generating']"
      );
      if (spinners.length > 0) return true;
      const lastResp = document.querySelector("model-response:last-of-type, message-content:last-of-type");
      if (lastResp) {
        const text = (lastResp.innerText || "").toLowerCase();
        if (text.includes("generating image") || text.includes("creating image") || text.includes("drawing")) return true;
      }
      return false;
    }).catch(() => false);

    const isStreamingDone = await page.evaluate(() => {
      const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], [data-test-id*="stop"]');
      if (stopBtn && stopBtn.offsetWidth > 0 && window.getComputedStyle(stopBtn).display !== "none") return false;
      const sendBtn = document.querySelector('button[aria-label*="Send" i], button[aria-label*="Envoyer" i], .send-button');
      const micBtn = document.querySelector('button[aria-label*="microphone" i], button[aria-label*="Dictate" i], button[aria-label*="Micro" i]');
      const editor = document.querySelector('rich-textarea div[contenteditable="true"], div[role="textbox"]');
      const copyBtn = document.querySelector('model-response button[aria-label*="Copy" i]');
      return Boolean(micBtn || copyBtn || (sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true") || (editor && editor.getAttribute("contenteditable") === "true"));
    }).catch(() => false);

    // Only inspect for text refusal if streaming is done AND no image spinner is active
    if (isStreamingDone && !isImageInProgress) {
      if (!streamingDoneStart) streamingDoneStart = Date.now();
      const elapsedSinceDone = Date.now() - streamingDoneStart;

      const toastMsg = await page.evaluate(() => {
        const el = document.querySelector('mat-snack-bar-container, [role="alert"], .snack-bar, .toast');
        return el ? el.innerText.trim() : null;
      }).catch(() => null);

      const responseText = await page.locator("model-response, message-content, [data-test-id='model-response-text']").last().innerText().catch(() => "");
      
      const isExplicitRefusal = /cannot generate|can't generate|cannot create images|not able to generate|policy prevents|safety guideline|against our policies/i.test(responseText);

      // If Gemini returned an explicit safety/policy refusal, fail fast
      if (isExplicitRefusal) {
        const finalError = toastMsg || responseText.slice(0, 140) || "Gemini refused image generation";
        throw new Error(`GEMINI_REFUSED_OR_TEXT: ${finalError}`);
      }

      // If streaming has finished, no image spinner is active, and 4.5s has elapsed,
      // Gemini produced text instead of an image. Fail fast to trigger in-session nudge / account retry.
      if (elapsedSinceDone > 4500) {
        const finalCount = await imgLoc.count().catch(() => 0);
        if (finalCount <= beforeCount) {
          const finalError = toastMsg || responseText.slice(0, 140) || "Gemini replied with text instead of image";
          throw new Error(`GEMINI_REFUSED_OR_TEXT: ${finalError}`);
        }
      }
    } else {
      streamingDoneStart = null;
    }

    await page.waitForTimeout(400);
  }
  throw new Error("timed out waiting for Gemini image render (65s)");
}

export async function generateImage({ prompt, imagePaths, page, outputPath = null, signal = null, accountId = null }) {
  const resolvedAccountId = accountId || getAccountIdForPage(page);
  return withGenerationCeiling(
    async () => {
      try {
        if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
        await ensureGeminiApp(page);
        await dismissModals(page);
        await page.waitForTimeout(200);

        const beforeCount = await page.locator("model-response img, .response-container img, [data-test-id*='response'] img").count().catch(() => 0);

        if (imagePaths?.length) {
          await attachReferenceImages(page, imagePaths, signal);
        }

        if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

        const editor = await fillPrompt(page, prompt);
        if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
        await submitPrompt(page, editor);

        try {
          return await monitorAndExtractOutput(page, beforeCount, 65000, outputPath, signal);
        } catch (err) {
          if (signal?.aborted || err?.name === "AbortError" || (err?.message || "").includes("cancelled by user")) {
            throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
          }

          const isTextRefusal = (err?.message || "").includes("GEMINI_REFUSED_OR_TEXT");
          const isHardQuota = /daily limit|reached your limit|quota exceeded|limit reached/i.test(err?.message || "");

          // Single focused in-session nudge (25s) before failing over to alternate fleet account
          if (isTextRefusal && !isHardQuota && !page.isClosed() && !signal?.aborted) {
            console.log("[geminiweb] Gemini replied with text. Executing fast in-session nudge (25s)...");
            const nudgePrompt = "Generate the image as requested above.";
            try {
              const countBeforeNudge = await page.locator("model-response img, .response-container img, [data-test-id*='response'] img").count().catch(() => 0);
              const nudgeEditor = await fillPrompt(page, nudgePrompt);
              if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
              await submitPrompt(page, nudgeEditor);
              const result = await monitorAndExtractOutput(page, countBeforeNudge, 25000, outputPath, signal);
              if (result) {
                console.log("[geminiweb] In-session nudge succeeded! Image captured on the same account.");
                return result;
              }
            } catch (nudgeErr) {
              if (signal?.aborted || nudgeErr?.name === "AbortError") throw nudgeErr;
              console.warn("[geminiweb] In-session nudge failed:", nudgeErr.message.slice(0, 80));
            }
            throw new Error("GEMINI_REFUSED_OR_TEXT: In-session nudge failed to generate an image");
          }
          throw err;
        }
      } finally {
        // Guarantees context detachment and cleans up references even on uncaught selector timeouts
        try {
          if (page && !page.isClosed()) {
            await page.evaluate(() => {
              window.stop?.();
            }).catch(() => {});
          }
        } catch (_) {}
      }
    },
    { page, accountId: resolvedAccountId, signal, ceilingMs: HARD_GENERATION_CEILING_MS }
  );
}

export async function ensureFlashLiteModel(page) {
  try {
    const modeBtn = page.locator('.input-area-switch, button[aria-label*="mode picker" i], button:has-text("Flash")').first();
    if (await modeBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      const currentMode = (await modeBtn.innerText().catch(() => "")).trim();
      if (!currentMode.toLowerCase().includes("lite")) {
        await modeBtn.click({ timeout: 800 }).catch(() => {});
        await page.waitForTimeout(300);
        const lite = page.locator('gem-menu-item:has-text("Flash-Lite"), [role="menuitem"]:has-text("Flash-Lite"), button:has-text("Flash-Lite")').first();
        if (await lite.isVisible({ timeout: 1000 }).catch(() => false)) {
          await lite.click({ timeout: 800 }).catch(() => {});
          await page.waitForTimeout(300);
          console.log("[geminiweb] Automatically set model to Flash-Lite (Fastest answers)");
        }
      }
    }
  } catch (_) {}
}

export async function ensureGeminiApp(page) {
  const currentUrl = page.url() || "";
  if (currentUrl.includes("accounts.google.com")) {
    throw new Error("SESSION_EXPIRED: Account redirected to Google login");
  }

  const isBaseAppUrl = currentUrl.endsWith("/app") || currentUrl.endsWith("/app/");
  const existingTurns = await page.locator("model-response, user-query").count().catch(() => 0);

  // If not on base /app or if existing conversation has turns, navigate directly to /app to reset context completely
  if (!currentUrl.includes("gemini.google.com/app") || !isBaseAppUrl || existingTurns > 0) {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    if ((page.url() || "").includes("accounts.google.com")) {
      throw new Error("SESSION_EXPIRED: Account redirected to Google login");
    }
  }

  // Wait until composer editor is recognized and interactive
  await dismissModals(page);
  const editorLoc = await findVisibleElement(page, SELECTORS.promptInput, 15000);
  if (!editorLoc) {
    throw new Error("Gemini composer editor not recognized after page load");
  }
  // Automatically ensure highest-speed Flash-Lite model is selected
  await ensureFlashLiteModel(page);
  // Activate composer by focusing the editor
  await editorLoc.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(150);
}

export async function checkSession(page, { navigate = true, fallbackEmail = null } = {}) {
  const status = { signedIn: false, email: null, page: "probe" };
  try {
    const startUrl = page.url() || "";
    if (!startUrl.includes(GEMINI_HOST)) {
      if (!navigate) { status.pending = true; return status; }
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    const url = page.url() || "";
    if (url.includes("accounts.google.com")) {
      status.signedIn = false;
      return status;
    }
    const readyByUrl = url.includes(GEMINI_HOST);
    if (!readyByUrl) {
      status.signedIn = false;
      return status;
    }
    status.signedIn = true;
    status.email = fallbackEmail;
    return status;
  } catch (err) {
    status.error = err.message;
    return status;
  }
}

function extractJSON(rawText) {
  if (!rawText) return null;
  const clean = String(rawText).replace(/```json\s*/gi, "").replace(/```\s*$/gi, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

export async function generateText({ prompt, imagePaths = [], page, signal = null, timeoutMs = 40000, accountId = null }) {
  const resolvedAccountId = accountId || getAccountIdForPage(page);
  return withGenerationCeiling(
    async () => {
      try {
        if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
        await ensureGeminiApp(page);
        await dismissModals(page);

        if (imagePaths?.length) {
          await attachReferenceImages(page, imagePaths, signal);
        }

        if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

        // Baseline: count model-response turns BEFORE submission
        const countBefore = await page.locator("model-response").count().catch(() => 0);

        const editor = await fillPrompt(page, prompt);
        if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
        await submitPrompt(page, editor);

        console.log(`[geminiweb] Monitoring Gemini text response (baseline turns: ${countBefore})...`);
        const start = Date.now();
        let lastText = "";
        let stableTicks = 0;
        let retriggered = false;

        while (Date.now() - start < timeoutMs) {
          if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

          // Proactive dispatch retry: If 10s elapsed with 0 turns and not generating, nudge send/enter once
          if (!retriggered && Date.now() - start > 5000) {
            retriggered = true;
            const needsNudge = await page.evaluate((prevCount) => {
              const turns = document.querySelectorAll("model-response").length;
              const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Arrêter" i]');
              return turns <= prevCount && (!stopBtn || stopBtn.offsetWidth === 0);
            }, countBefore).catch(() => false);

            if (needsNudge) {
              console.warn("[geminiweb] Turn not detected after 10s, attempting proactive prompt submission nudge...");
              try {
                const send = page.locator(SELECTORS.sendButton.join(", ")).first();
                if (await send.isVisible({ timeout: 1000 }).catch(() => false)) {
                  await send.click({ timeout: 2000 }).catch(() => {});
                } else {
                  await editor.focus().catch(() => {});
                  await page.keyboard.press("Enter").catch(() => {});
                }
              } catch (_) {}
            }
          }

          const probe = await page.evaluate((prevCount) => {
            const errorEl = document.querySelector(
              'mat-snack-bar-container, [role="alert"], [role="dialog"], .error-container, .response-error, [data-test-id*="error"]'
            );
            const toastMsg = errorEl ? (errorEl.innerText || "").trim() : null;

            const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], [data-test-id*="stop"]');
            const isGenerating = Boolean(
              stopBtn &&
              window.getComputedStyle(stopBtn).display !== "none" &&
              window.getComputedStyle(stopBtn).visibility !== "hidden" &&
              stopBtn.offsetWidth > 0
            );

            const turns = document.querySelectorAll("model-response");
            let text = "";
            let hasCopyBtn = false;
            if (turns.length > prevCount) {
              const last = turns[turns.length - 1];
              const content = last.querySelector("message-content, structured-content-container, .model-response-text") || last;
              text = (content.innerText || "").trim();
              hasCopyBtn = Boolean(last.querySelector('button[aria-label*="Copy" i], button[aria-label*="Copier" i]'));
            } else if (turns.length > 0) {
              // Fallback: If turn count did not strictly exceed prevCount (e.g. baseline counted stale DOM or reset occurred),
              // inspect the last turn if it has active completion markers or content
              const last = turns[turns.length - 1];
              const copyBtn = last.querySelector('button[aria-label*="Copy" i], button[aria-label*="Copier" i]');
              const content = last.querySelector("message-content, structured-content-container, .model-response-text") || last;
              const candidate = (content.innerText || "").trim();
              if (copyBtn || isGenerating || candidate.length > 30) {
                text = candidate;
                hasCopyBtn = Boolean(copyBtn);
              }
            }

            return { toastMsg, isGenerating, hasCopyBtn, text };
          }, countBefore).catch(() => ({ toastMsg: null, isGenerating: false, hasCopyBtn: false, text: "" }));

          if (probe.toastMsg && /limit|quota|error|try again|failed|unable|something went wrong|cannot help/i.test(probe.toastMsg)) {
            throw new Error(`GEMINI_ERROR: ${probe.toastMsg.slice(0, 120)}`);
          }

          // Fast-fail if generation never started after 16s and prompt nudge already dispatched
          if (Date.now() - start > 16000 && !probe.isGenerating && !probe.text && retriggered) {
            throw new Error("GEMINI_STALLED: Generation failed to start after 16s");
          }

          const trimmed = probe.text;
          if (trimmed.length > 0) {
            // Early JSON return: As soon as braces appear, parse and validate
            if (trimmed.includes("{") && trimmed.includes("}")) {
              const parsed = extractJSON(trimmed);
              if (parsed && typeof parsed === "object") {
                if (parsed.title || parsed.main_tag || parsed.bullet1 || parsed.description) {
                  console.log(`[geminiweb] Valid listing JSON detected early (${trimmed.length} chars), returning IMMEDIATELY.`);
                  return trimmed;
                }
              }
            }

            // Fast-path A: Copy button rendered = generation definitely complete (any non-empty text)
            if (probe.hasCopyBtn && !probe.isGenerating) {
              console.log(`[geminiweb] Text captured via Copy button + not-generating (${trimmed.length} chars).`);
              return trimmed;
            }
            // Fast-path B: Copy button present even while still in streaming (text is already final for this turn)
            if (probe.hasCopyBtn && trimmed.length > 5) {
              console.log(`[geminiweb] Text captured via Copy button detection (${trimmed.length} chars).`);
              return trimmed;
            }
            if (!probe.isGenerating) {
              // Immediate JSON resolution: stable closed JSON for 1 tick (relax length threshold)
              if (trimmed === lastText && trimmed.includes("{") && trimmed.includes("}") && trimmed.length > 10) {
                console.log(`[geminiweb] JSON captured immediately (${trimmed.length} chars).`);
                return trimmed;
              }
              // Stability fallback: same text for 2 consecutive ticks
              if (trimmed === lastText) {
                if (++stableTicks >= 2) {
                  console.log(`[geminiweb] Text captured via stability (${trimmed.length} chars).`);
                  return trimmed;
                }
              } else {
                stableTicks = 0;
              }
            } else {
              stableTicks = 0;
            }
            lastText = trimmed;
          }

          await page.waitForTimeout(150);
        }

        if (lastText.length > 0) {
          console.log(`[geminiweb] Returning last captured text at deadline (${lastText.length} chars).`);
          return lastText;
        }
        throw new Error(`Timed out waiting for Gemini text response (${Math.round(timeoutMs / 1000)}s)`);
      } finally {
        try {
          if (page && !page.isClosed()) {
            await page.evaluate(() => {
              window.stop?.();
            }).catch(() => {});
          }
        } catch (_) {}
      }
    },
    { page, accountId: resolvedAccountId, signal, ceilingMs: HARD_GENERATION_CEILING_MS }
  );
}

export async function debugPage(page) {
  return { url: page.url(), title: await page.title().catch(() => null) };
}
