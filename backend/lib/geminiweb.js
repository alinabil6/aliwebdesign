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

async function attachReferenceImages(page, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return;
  await dismissModals(page);
  const beforePreview = await page.locator(PREVIEW_SELECTOR).count().catch(() => 0);

  await page.locator('rich-textarea, .ql-editor, div[contenteditable="true"]').first().waitFor({ state: "attached", timeout: 20000 }).catch(() => {});

  const attachLoc = page.locator('button[aria-label*="Upload and tools" i], button[aria-label*="Upload & tools" i], button:has(mat-icon[data-mat-icon-name*="add"]):not(nav *):not(aside *)').first();
  await attachLoc.waitFor({ state: "visible", timeout: 20000 });

  console.log("[geminiweb] Clicking attach button (force: true)...");
  await attachLoc.click({ force: true, timeout: 5000 });
  await page.waitForTimeout(400);

  const uploadItem = page.locator('[role="menu"] [role="menuitem"]:has-text("Upload files"), [role="menuitem"][aria-label*="Upload files" i], [role="menuitem"]:has-text("Upload")').first();
  await uploadItem.waitFor({ state: "visible", timeout: 8000 });

  console.log("[geminiweb] Binding files via filechooser...");
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 12000 }).catch(() => null),
    uploadItem.click({ force: true, timeout: 4000 })
  ]);

  if (fileChooser) {
    await fileChooser.setFiles(imagePaths);
  } else {
    const fallbackInput = page.locator('input[type="file"]').last();
    await fallbackInput.setInputFiles(imagePaths, { timeout: 4000 });
  }

  console.log(`[geminiweb] Uploaded ${imagePaths.length} reference image(s)`);
  await waitForAttachmentPreview(page, beforePreview, Math.max(6000, imagePaths.length * 3000), imagePaths.length);
}

async function fillPrompt(page, promptText) {
  const editor = await firstVisible(page, SELECTORS.promptInput, { timeout: 20000 });
  if (!editor) throw new Error("Gemini prompt editor not found");
  await editor.fill(promptText);
  await editor.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }).catch(() => {});
  return editor;
}

async function submitPrompt(page, editor) {
  console.log("[geminiweb] Submitting prompt...");
  const sendSelector = SELECTORS.sendButton.join(", ");
  const deadline = Date.now() + 15000;
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    const send = page.locator(sendSelector).first();
    if (await send.isVisible().catch(() => false)) {
      await send.click({ force: true, timeout: 3000 }).catch(() => {});
      clicked = true;
      break;
    }
    await page.waitForTimeout(300);
  }
  if (!clicked) {
    await editor.focus().catch(() => {});
    await page.keyboard.press("Enter");
  }
  console.log("[geminiweb] Prompt submitted successfully.");
}

async function monitorAndExtractOutput(page, beforeCount, timeout = 120000) {
  const start = Date.now();
  const deadline = start + timeout;
  console.log("[geminiweb] Waiting for output image render...");
  const imgLoc = page.locator("model-response img, .response-container img, [data-test-id*='response'] img");
  
  await page.waitForTimeout(4000);

  while (Date.now() < deadline) {
    const count = await imgLoc.count().catch(() => 0);
    if (count > beforeCount) {
      const target = imgLoc.last();
      const isValid = await target.evaluate((img) => img.complete && img.naturalWidth >= 512).catch(() => false);
      if (isValid) {
        const base64Data = await page.evaluate(async () => {
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
            return canvas.toDataURL("image/png").split(",")[1];
          } catch {
            return null;
          }
        }).catch(() => null);

        if (base64Data && base64Data.length > 5000) {
          const buf = Buffer.from(base64Data, "base64");
          console.log(`[geminiweb] captured ${buf.length} bytes via clean in-memory canvas`);
          return buf;
        }
      }
    }

    const isStreamingDone = await page.evaluate(() => {
      const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], [data-test-id*="stop"]');
      if (stopBtn) return false;
      const sendBtn = document.querySelector('button[aria-label*="Send" i], button[aria-label*="Envoyer" i], .send-button');
      return sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true";
    }).catch(() => false);

    if (isStreamingDone) {
      // 2.5s settling check so slow-mounting <img> elements are not mistaken for text refusals
      await page.waitForTimeout(2500);
      const finalCount = await imgLoc.count().catch(() => 0);
      if (finalCount <= beforeCount) {
        const toastMsg = await page.evaluate(() => {
          const el = document.querySelector('mat-snack-bar-container, [role="alert"], .snack-bar, .toast');
          return el ? el.innerText.trim() : null;
        }).catch(() => null);

        const responseText = await page.locator("model-response, message-content, [data-test-id='model-response-text']").last().innerText().catch(() => "");
        const finalError = toastMsg || responseText.slice(0, 140) || "Gemini replied with text instead of image";
        throw new Error(`GEMINI_REFUSED_OR_TEXT: ${finalError}`);
      }
    }

    await page.waitForTimeout(800);
  }
  throw new Error("timed out waiting for Gemini image render (120s)");
}

export async function generateImage({ prompt, imagePaths, page }) {
  await ensureGeminiApp(page);
  await dismissModals(page);
  await page.waitForTimeout(400);

  const beforeCount = await page.locator("model-response img, .response-container img, [data-test-id*='response'] img").count().catch(() => 0);

  if (imagePaths?.length) {
    await attachReferenceImages(page, imagePaths);
  }

  const editor = await fillPrompt(page, prompt);
  await submitPrompt(page, editor);

  try {
    return await monitorAndExtractOutput(page, beforeCount, 85000);
  } catch (err) {
    const isTextRefusal = (err?.message || "").includes("GEMINI_REFUSED_OR_TEXT");
    const isHardQuota = /daily limit|reached your limit|quota exceeded|limit reached/i.test(err?.message || "");

    // IN-SESSION RETRY: If Gemini returned conversational text and it is not a hard quota, nudge in the SAME chat!
    if (isTextRefusal && !isHardQuota && !page.isClosed()) {
      console.log("[geminiweb] Gemini replied with text. Nudging in the SAME session without re-attaching...");
      try {
        const nudgeText = "Create and render the full-color 2D vector graphic illustration image now. Execute visual image generation for the requested t-shirt artwork immediately: flat 2D screen-print illustration, clean vector linework, isolated on solid background.";
        const countBeforeNudge = await page.locator("model-response img, .response-container img, [data-test-id*='response'] img").count().catch(() => 0);
        const nudgeEditor = await fillPrompt(page, nudgeText);
        await submitPrompt(page, nudgeEditor);
        const result = await monitorAndExtractOutput(page, countBeforeNudge, 65000);
        if (result) {
          console.log("[geminiweb] In-session retry succeeded! Image captured on the same account.");
          return result;
        }
      } catch (nudgeErr) {
        console.warn("[geminiweb] In-session nudge did not generate image:", nudgeErr.message.slice(0, 80));
      }
    }
    throw err;
  }
}

async function ensureGeminiApp(page) {
  const currentUrl = page.url() || "";
  if (currentUrl.includes("accounts.google.com")) {
    throw new Error("SESSION_EXPIRED: Account redirected to Google login");
  }
  if (!currentUrl.includes("gemini.google.com/app")) {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    if ((page.url() || "").includes("accounts.google.com")) {
      throw new Error("SESSION_EXPIRED: Account redirected to Google login");
    }
    return;
  }
  const newChatBtn = page.locator('a[href="/app"], a[href="/app/"], button[aria-label*="New chat" i], button[aria-label*="Nouvelle discussion" i]').first();
  if (await newChatBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await newChatBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }
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

export async function generateText({ prompt, imagePaths = [], page }) {
  await ensureGeminiApp(page);
  await dismissModals(page);
  if (imagePaths?.length) {
    await attachReferenceImages(page, imagePaths);
  }
  const editor = await fillPrompt(page, prompt);
  await submitPrompt(page, editor);
  await page.waitForTimeout(4000);
  return await page.locator("model-response").last().innerText().catch(() => "Response generated");
}

export async function debugPage(page) {
  return { url: page.url(), title: await page.title().catch(() => null) };
}
