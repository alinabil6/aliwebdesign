import fs from "fs";
import { closeProfile, closeProfileForPage, getAccountIdForPage } from "./browser.js";

export class GenerationTimeoutError extends Error {
  constructor(message = "Per-account generation ceiling exceeded (150s)") {
    super(message);
    this.name = "GenerationTimeoutError";
    this.code = "GENERATION_TIMEOUT";
    this.isTimeout = true;
  }
}

export const HARD_GENERATION_CEILING_MS = 150000; // 150s absolute per-account ceiling

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

async function getVisibleAttachButton(page) {
  for (const sel of SELECTORS.attachButton) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        return el;
      }
    }
  }
  return null;
}

async function getVisibleUploadItem(page) {
  for (const sel of SELECTORS.uploadMenuItem) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        return el;
      }
    }
  }
  return null;
}

async function firstVisible(page, candidates, { timeout = 5000 } = {}) {
  const list = [].concat(candidates);
  try {
    const combined = page.locator(list.join(", ")).first();
    await combined.waitFor({ state: "visible", timeout });
    return combined;
  } catch {
    return null;
  }
}

async function dismissModals(page) {
  try {
    const modalSelectors = [
      'button:has-text("Agree")', 'button:has-text("Accept all")', 'button:has-text("Got it")', 'button:has-text("Dismiss")', 'button:has-text("Not now")',
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

async function waitForAttachmentPreview(page, beforePreviewCount, maxMs = 15000, expectedCount = 1) {
  const loc = page.locator(PREVIEW_SELECTOR);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const n = await loc.count().catch(() => 0);
    if (n >= beforePreviewCount + expectedCount) return true;
    await page.waitForTimeout(200);
  }
  return (await loc.count().catch(() => 0)) > beforePreviewCount;
}

async function waitForUploadCompletion(page, maxMs = 20000) {
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

  // 1. Ensure the composer toolbar is fully mounted in the DOM
  await page.locator('rich-textarea, mat-toolbar, div[contenteditable="true"], .input-area, .composer-root, div[role="textbox"]')
    .first()
    .waitFor({ state: "visible", timeout: 12000 })
    .catch(() => {});
  await page.waitForTimeout(400);

  // 2. Strategy A (Primary path): Direct <input type="file"> DOM bypass (setInputFiles)
  const directInput = page.locator(SELECTORS.fileInput.join(", ")).last();
  if (await directInput.count().catch(() => 0) > 0) {
    try {
      await directInput.setInputFiles(imagePaths, { timeout: 3000 });
      const mounted = await waitForAttachmentPreview(page, beforePreview, 4000, imagePaths.length);
      if (mounted) {
        console.log(`[geminiweb] Uploaded ${imagePaths.length} reference image(s) via direct input bypass`);
        await waitForUploadCompletion(page);
        return;
      }
    } catch (_) {}
  }

  if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

  // 3. Strategy B (UI fallback clicking): Fast 8s failover timeout
  let uploadItem = await getVisibleUploadItem(page);

  if (!uploadItem) {
    console.log("[geminiweb] Clicking attach button...");
    let attachBtn = await getVisibleAttachButton(page);
    if (!attachBtn) {
      await page.waitForTimeout(500);
      attachBtn = await getVisibleAttachButton(page);
    }

    if (attachBtn) {
      await attachBtn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      uploadItem = await getVisibleUploadItem(page);
      if (!uploadItem) {
        await page.waitForTimeout(300);
        await attachBtn.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        uploadItem = await getVisibleUploadItem(page);
      }
    }
  }

  if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

  console.log("[geminiweb] Binding files via filechooser...");
  let fileChooser = null;
  if (uploadItem) {
    const res = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null),
      uploadItem.click({ timeout: 4000 }).catch(() => {})
    ]);
    fileChooser = res[0];
  } else {
    const fallbackItem = page.locator(SELECTORS.uploadMenuItem.join(", ")).first();
    const res = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null),
      fallbackItem.click({ timeout: 4000 }).catch(() => {})
    ]);
    fileChooser = res[0];
  }

  if (fileChooser) {
    await fileChooser.setFiles(imagePaths);
    console.log(`[geminiweb] Bound ${imagePaths.length} file(s) to filechooser.`);
  } else {
    console.warn("[geminiweb] Filechooser event not caught, trying fallback file input...");
    const fallbackInput = page.locator(SELECTORS.fileInput.join(", ")).last();
    await fallbackInput.setInputFiles(imagePaths, { timeout: 4000 }).catch(() => {});
  }

  // 4. Verify attachment mounted in DOM and wait for upload completion
  const mounted = await waitForAttachmentPreview(page, beforePreview, Math.max(8000, imagePaths.length * 4000), imagePaths.length);
  if (!mounted) {
    console.warn("[geminiweb] Attachment preview chip not immediately detected, waiting for upload settling...");
  }
  await waitForUploadCompletion(page);
  console.log(`[geminiweb] Uploaded ${imagePaths.length} reference image(s)`);
}

async function fillPrompt(page, promptText) {
  const editor = await firstVisible(page, SELECTORS.promptInput, { timeout: 20000 });
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
  const sendSelector = SELECTORS.sendButton.join(", ");
  const uqBefore = await page.locator("user-query, .user-query-container").count().catch(() => 0);
  const mrBefore = await page.locator("model-response").count().catch(() => 0);

  const checkDispatched = () => page.evaluate(({ uqPrev, mrPrev }) => {
    const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], [data-test-id*="stop"]');
    if (stopBtn && window.getComputedStyle(stopBtn).display !== "none" && stopBtn.offsetWidth > 0) return true;
    if (document.querySelectorAll("user-query, .user-query-container").length > uqPrev) return true;
    if (document.querySelectorAll("model-response").length > mrPrev) return true;
    return false;
  }, { uqPrev: uqBefore, mrPrev: mrBefore }).catch(() => false);

  // Wait for the send button to become enabled (it is disabled while images are still uploading)
  const send = page.locator(sendSelector).first();
  await send.waitFor({ state: "visible", timeout: 12000 }).catch(() => {});

  const deadline = Date.now() + 30000;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const sendVisible = await send.isVisible().catch(() => false);
    if (sendVisible) {
      await send.click({ timeout: 3000 }).catch(() => {});
    } else {
      await editor.focus().catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    }

    // Poll every 300ms for up to 2.1s per attempt
    for (let w = 0; w < 7; w++) {
      await page.waitForTimeout(300);
      if (await checkDispatched()) {
        console.log(`[geminiweb] Prompt submitted successfully (confirmed on attempt ${attempts}).`);
        return;
      }
    }

    // If click didn't confirm dispatch on this attempt, try pressing Enter as alternative
    if (sendVisible) {
      await editor.focus().catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(600);
      if (await checkDispatched()) {
        console.log(`[geminiweb] Prompt submitted successfully via Enter fallback (attempt ${attempts}).`);
        return;
      }
    }
  }
  console.log("[geminiweb] Prompt submission loop finished (unconfirmed).");
}

async function monitorAndExtractOutput(page, beforeCount, timeout = 120000, outputPath = null, signal = null) {
  const start = Date.now();
  const deadline = start + timeout;
  console.log("[geminiweb] Waiting for output image render...");
  const imgLoc = page.locator("model-response img, .response-container img, [data-test-id*='response'] img");

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
      if (stopBtn) return false;
      const sendBtn = document.querySelector('button[aria-label*="Send" i], button[aria-label*="Envoyer" i], .send-button');
      return sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true";
    }).catch(() => false);

    // Only inspect for text refusal if streaming is done AND no image spinner is active
    if (isStreamingDone && !isImageInProgress) {
      const elapsed = Date.now() - start;

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

      // If it is NOT an explicit refusal, give Nano Banana 2 a generous window to render
            // (Gemini often streams an introductory conversational sentence while Nano Banana 2
            // generates in parallel — the image can take 60–90s to appear). Declaring a "text
            // refusal" too early was the #1 cause of 3–4 minute runs: it aborted a healthy
            // generation, quarantined the account, and re-routed the whole task to a fresh
            // account that had to re-upload and re-submit from scratch.
            if (elapsed > 90000) {
              const finalCount = await imgLoc.count().catch(() => 0);
              if (finalCount <= beforeCount) {
                const finalError = toastMsg || responseText.slice(0, 140) || "Gemini replied with text instead of image";
                throw new Error(`GEMINI_REFUSED_OR_TEXT: ${finalError}`);
              }
            }
    }

    await page.waitForTimeout(400);
  }
  throw new Error("timed out waiting for Gemini image render (120s)");
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
          return await monitorAndExtractOutput(page, beforeCount, 120000, outputPath, signal);
        } catch (err) {
          if (signal?.aborted || err?.name === "AbortError" || (err?.message || "").includes("cancelled by user")) {
            throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
          }

          const isTextRefusal = (err?.message || "").includes("GEMINI_REFUSED_OR_TEXT");
          const isHardQuota = /daily limit|reached your limit|quota exceeded|limit reached/i.test(err?.message || "");

          // Fix 3: Two progressive nudges instead of one for text refusals
          if (isTextRefusal && !isHardQuota && !page.isClosed() && !signal?.aborted) {
            console.log("[geminiweb] Gemini replied with text. Executing progressive 2-step in-session nudges...");
            const MAX_NUDGES = 2;
            for (let nudge = 0; nudge < MAX_NUDGES; nudge++) {
              if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
              const nudgePrompt = nudge === 0
                ? "Generate the image as requested above."
                : "Please output only the graphic design image, no text response.";
              console.log(`[geminiweb] In-session nudge ${nudge + 1}/${MAX_NUDGES}: "${nudgePrompt}"`);
              try {
                const countBeforeNudge = await page.locator("model-response img, .response-container img, [data-test-id*='response'] img").count().catch(() => 0);
                const nudgeEditor = await fillPrompt(page, nudgePrompt);
                if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
                await submitPrompt(page, nudgeEditor);
                const result = await monitorAndExtractOutput(page, countBeforeNudge, 45000, outputPath, signal);
                if (result) {
                  console.log(`[geminiweb] In-session nudge ${nudge + 1} succeeded! Image captured on the same account.`);
                  return result;
                }
              } catch (nudgeErr) {
                if (signal?.aborted || nudgeErr?.name === "AbortError") throw nudgeErr;
                console.warn(`[geminiweb] In-session nudge ${nudge + 1} failed:`, nudgeErr.message.slice(0, 80));
              }
            }
            throw new Error("GEMINI_REFUSED_OR_TEXT: Both in-session nudges failed to generate an image");
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

export async function ensureGeminiApp(page) {
  const currentUrl = page.url() || "";
  if (currentUrl.includes("accounts.google.com")) {
    throw new Error("SESSION_EXPIRED: Account redirected to Google login");
  }

  const isBaseAppUrl = currentUrl.endsWith("/app") || currentUrl.endsWith("/app/");
  const existingTurns = await page.locator("model-response, user-query").count().catch(() => 0);

  if (!currentUrl.includes("gemini.google.com/app")) {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    if ((page.url() || "").includes("accounts.google.com")) {
      throw new Error("SESSION_EXPIRED: Account redirected to Google login");
    }
  } else if (!isBaseAppUrl || existingTurns > 0) {
    // Already on Gemini but in a previous conversation — click New Chat and wait for turns to clear
    const newChatBtn = page.locator(
      'a[href="/app"], a[href="/app/"], button[aria-label*="New chat" i], button[aria-label*="Nouvelle discussion" i]'
    ).first();

    let resetOk = false;
    if (await newChatBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await newChatBtn.click({ timeout: 2000 }).catch(() => {});
      resetOk = await page.waitForFunction(() => {
        return document.querySelectorAll("model-response, user-query").length === 0;
      }, { timeout: 3500 }).then(() => true).catch(() => false);
    }

    if (!resetOk) {
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      if ((page.url() || "").includes("accounts.google.com")) {
        throw new Error("SESSION_EXPIRED: Account redirected to Google login");
      }
      await page.waitForFunction(() => {
        return document.querySelectorAll("model-response, user-query").length === 0;
      }, { timeout: 4000 }).catch(() => {});
    }
  }

  // Wait until the composer editor is interactive before proceeding
  const editorLoc = page.locator('rich-textarea div[contenteditable="true"], .ql-editor, div[role="textbox"]').first();
  await editorLoc.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  // Activate composer by focusing the editor
  await editorLoc.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(400);
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

export async function generateText({ prompt, imagePaths = [], page, signal = null, timeoutMs = 90000, accountId = null }) {
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
          if (!retriggered && Date.now() - start > 10000) {
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
            const toastEl = document.querySelector('mat-snack-bar-container, [role="alert"]');
            const toastMsg = toastEl ? (toastEl.innerText || "").trim() : null;

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

          if (probe.toastMsg && /limit|quota|error|try again|failed|unable/i.test(probe.toastMsg)) {
            throw new Error(`GEMINI_ERROR: ${probe.toastMsg}`);
          }

          const trimmed = probe.text;
          if (trimmed.length > 0) {
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
              // Stability fallback: same text for 2 consecutive ticks (~800ms)
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

          await page.waitForTimeout(400);
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
