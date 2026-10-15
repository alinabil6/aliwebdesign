import fs from "fs";

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
    'button[aria-label*="Upload and tools" i]',
    'button[aria-label*="Upload & tools" i]',
    'button[aria-label*="Upload" i]:not(nav *):not(aside *)',
    'button:has(mat-icon[data-mat-icon-name*="add"]):not(nav *):not(aside *)',
  ],
  uploadMenuItem: [
    '[role="menu"] [role="menuitem"]:has-text("Upload files")',
    '[role="menuitem"][aria-label*="Upload files" i]',
    '.cdk-overlay-container [role="menuitem"]:has-text("Upload")',
    '[role="menuitem"]:has-text("Upload files")',
  ],
  outputImage: "model-response img, .response-container img, [data-test-id*='response'] img",
  signedInAvatar: ['[aria-label*="Google Account"]', '[aria-label*="@"]', '.gb_A'],
  signInButton: ['a[href*="accounts.google.com"]', 'button:has-text("Sign in")'],
};

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

const PREVIEW_SELECTOR = ".file-preview, .uploaded-image, mat-chip, [aria-label*='Remove' i], img[src^='blob:'], img[src^='data:']";

async function waitForAttachmentPreview(page, beforePreviewCount, maxMs = 8000, expectedCount = 1) {
  const loc = page.locator(PREVIEW_SELECTOR);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const n = await loc.count().catch(() => 0);
    if (n >= beforePreviewCount + expectedCount) return true;
    await page.waitForTimeout(200);
  }
  return (await loc.count().catch(() => 0)) > beforePreviewCount;
}

async function attachReferenceImages(page, imagePaths, signal = null) {
  if (!imagePaths || imagePaths.length === 0) return;
  if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
  await dismissModals(page);
  const beforePreview = await page.locator(PREVIEW_SELECTOR).count().catch(() => 0);

  // 1. Ensure the composer toolbar is fully mounted in the DOM (fast 8s failover)
  await page.locator('rich-textarea, mat-toolbar, div[contenteditable="true"], .input-area, .composer-root')
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .catch(() => {});
  // Wait for composer idle state so that Angular animations do not toggle the attachment dropdown shut
  await page.waitForTimeout(400);

  // 2. Strategy A (Primary path): Direct <input type="file"> DOM bypass (setInputFiles)
  const directInput = page.locator(SELECTORS.fileInput.join(", ")).last();
  if (await directInput.count().catch(() => 0) > 0) {
    try {
      await directInput.setInputFiles(imagePaths, { timeout: 3000 });
      const mounted = await waitForAttachmentPreview(page, beforePreview, 4000, imagePaths.length);
      if (mounted) {
        console.log(`[geminiweb] Uploaded ${imagePaths.length} reference image(s) via direct input bypass`);
        return;
      }
    } catch (_) {}
  }

  if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

  // 3. Strategy B (UI fallback clicking): Fast 8s failover timeout
  const attachSelector = SELECTORS.attachButton.join(", ");
  const attachLoc = page.locator(attachSelector).first();
  await attachLoc.waitFor({ state: "visible", timeout: 8000 });

  const uploadMenuSelector = SELECTORS.uploadMenuItem.join(", ");
  const uploadItem = page.locator(uploadMenuSelector).first();

  let isMenuOpen = await uploadItem.isVisible().catch(() => false);
  if (!isMenuOpen) {
    console.log("[geminiweb] Clicking attach button...");
    await attachLoc.click({ timeout: 4000 }).catch(() => {});
    // Wait for composer idle state & Angular dropdown animation
    isMenuOpen = await uploadItem.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
    if (!isMenuOpen) {
      await page.waitForTimeout(300);
      await attachLoc.click({ force: true, timeout: 3000 }).catch(() => {});
      isMenuOpen = await uploadItem.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
    }
  }

  if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

  console.log("[geminiweb] Binding files via filechooser...");
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null),
    uploadItem.click({ timeout: 3000 }).catch(() => {})
  ]);

  if (fileChooser) {
    await fileChooser.setFiles(imagePaths);
  } else {
    const fallbackInput = page.locator(SELECTORS.fileInput.join(", ")).last();
    await fallbackInput.setInputFiles(imagePaths, { timeout: 3000 }).catch(() => {});
  }

  console.log(`[geminiweb] Uploaded ${imagePaths.length} reference image(s)`);
  await waitForAttachmentPreview(page, beforePreview, Math.max(5000, imagePaths.length * 2500), imagePaths.length);
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
    const ed = document.querySelector('rich-textarea div[contenteditable="true"], .ql-editor, div[role="textbox"]');
    return (ed?.innerText || "").trim().length === 0;
  }, { uqPrev: uqBefore, mrPrev: mrBefore }).catch(() => false);

  const deadline = Date.now() + 30000;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const send = page.locator(sendSelector).first();
    if (await send.isVisible().catch(() => false)) {
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

      // If it is NOT an explicit refusal, give Nano Banana 2 at least 45 seconds to render
      // (Gemini often streams an introductory conversational sentence while Nano Banana 2 generates in parallel)
      if (elapsed > 45000) {
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

export async function generateImage({ prompt, imagePaths, page, outputPath = null, signal = null }) {
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
      return await monitorAndExtractOutput(page, beforeCount, 85000, outputPath, signal);
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
}

async function ensureGeminiApp(page) {
  const currentUrl = page.url() || "";
  if (currentUrl.includes("accounts.google.com")) {
    throw new Error("SESSION_EXPIRED: Account redirected to Google login");
  }
  if (!currentUrl.includes("gemini.google.com/app")) {
    await page.goto(GEMINI_URL, { waitUntil: "commit", timeout: 20000 }).catch(() => {});
    if ((page.url() || "").includes("accounts.google.com")) {
      throw new Error("SESSION_EXPIRED: Account redirected to Google login");
    }
  } else {
    // Already on Gemini — click New Chat so the 2nd design starts a fresh conversation
    const newChatBtn = page.locator(
      'a[href="/app"], a[href="/app/"], button[aria-label*="New chat" i], button[aria-label*="Nouvelle discussion" i]'
    ).first();
    if (await newChatBtn.isVisible().catch(() => false)) {
      await newChatBtn.click({ timeout: 2000 }).catch(() => {});
    }
  }
  // Wait until the composer editor is interactive before proceeding
  await page.locator('rich-textarea div[contenteditable="true"], .ql-editor, div[role="textbox"]')
    .first()
    .waitFor({ state: "visible", timeout: 25000 })
    .catch(() => {});
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

export async function generateText({ prompt, imagePaths = [], page, signal = null, timeoutMs = 90000 }) {
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

  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });

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
      }

      return { toastMsg, isGenerating, hasCopyBtn, text };
    }, countBefore).catch(() => ({ toastMsg: null, isGenerating: false, hasCopyBtn: false, text: "" }));

    if (probe.toastMsg && /limit|quota|error|try again|failed|unable/i.test(probe.toastMsg)) {
      throw new Error(`GEMINI_ERROR: ${probe.toastMsg}`);
    }

    const trimmed = probe.text;
    if (trimmed.length > 0) {
      // Fast-path: Copy button rendered = generation definitely complete
      if (probe.hasCopyBtn && trimmed.length > 20) {
        console.log(`[geminiweb] Text captured via Copy button detection (${trimmed.length} chars).`);
        return trimmed;
      }
      if (!probe.isGenerating) {
        // Immediate JSON resolution: stable closed JSON for 1 tick
        if (trimmed === lastText && trimmed.includes("{") && trimmed.includes("}") && trimmed.length > 40) {
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
}

export async function debugPage(page) {
  return { url: page.url(), title: await page.title().catch(() => null) };
}
