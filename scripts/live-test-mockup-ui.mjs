import { chromium } from "playwright";
import sharp from "sharp";
import fs from "fs";
import path from "path";

async function runLiveTest() {
  console.log("=== STARTING MOCKUP CREATOR LIVE UI TEST ===");

  // 1. Generate test garment & artwork images
  const testGarmentPath = path.resolve("test-garment.png");
  const testArtworkPath = path.resolve("test-artwork.png");

  // Garment: Simple white t-shirt silhouette mockup on neutral grey
  const garmentSvg = `
    <svg width="800" height="1000" viewBox="0 0 800 1000" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="1000" fill="#e2e8f0" />
      <!-- Stylized T-Shirt body -->
      <path d="M 260 120 C 340 170, 460 170, 540 120 L 700 240 L 620 340 L 550 280 L 550 860 L 250 860 L 250 280 L 180 340 L 100 240 Z" fill="#ffffff" stroke="#cbd5e1" stroke-width="6"/>
      <text x="400" y="930" font-family="sans-serif" font-size="28" fill="#64748b" text-anchor="middle">Base Commercial Garment Mockup</text>
    </svg>
  `;
  await sharp(Buffer.from(garmentSvg)).png().toFile(testGarmentPath);

  // Artwork: Vibrant POD graphic logo with transparent background
  const artworkSvg = `
    <svg width="600" height="600" viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg">
      <circle cx="300" cy="300" r="260" fill="#ff4757" />
      <polygon points="300,90 365,220 510,240 405,340 430,480 300,410 170,480 195,340 90,240 235,220" fill="#ffd32a" />
      <text x="300" y="320" font-family="Impact, sans-serif" font-size="64" fill="#ffffff" text-anchor="middle" font-weight="bold">WILD THUNDER</text>
      <text x="300" y="370" font-family="sans-serif" font-size="28" fill="#ffffff" text-anchor="middle" letter-spacing="4">VINTAGE APPAREL</text>
    </svg>
  `;
  await sharp(Buffer.from(artworkSvg)).png().toFile(testArtworkPath);

  console.log("[test] Created test garment & artwork assets.");

  // 2. Launch browser to inspect UI
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();

  const consoleLogs = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    const text = `[browser-console] ${msg.type()}: ${msg.text()}`;
    consoleLogs.push(text);
    if (msg.type() === "error") {
      console.error(text);
    }
  });

  page.on("pageerror", (err) => {
    console.error("[browser-pageerror]", err.message);
    pageErrors.push(err.message);
  });

  try {
    console.log("[test] Navigating to http://127.0.0.1:3000 ...");
    await page.goto("http://127.0.0.1:3000", { waitUntil: "networkidle", timeout: 15000 });

    // Click Mockup Creator in navigation
    console.log("[test] Clicking Mockup Creator nav button...");
    const navBtn = page.locator('button[data-view="mockups"]');
    await navBtn.waitFor({ state: "visible", timeout: 5000 });
    await navBtn.click();

    // Verify view has mounted
    await page.waitForSelector("#mockupGarmentDrop", { timeout: 5000 });
    console.log("[test] Mockup Creator view mounted successfully!");

    // Upload garment
    console.log("[test] Uploading garment reference...");
    const garmentInput = page.locator("#mockupGarmentInput");
    await garmentInput.setInputFiles(testGarmentPath);
    await page.waitForSelector("#mockupGarmentPreview:not(.hidden)", { timeout: 3000 });
    console.log("[test] Garment preview confirmed visible!");

    // Upload artwork
    console.log("[test] Uploading artwork graphic...");
    const artworkInput = page.locator("#mockupArtworkInput");
    await artworkInput.setInputFiles(testArtworkPath);
    await page.waitForSelector("#mockupArtworkPreview:not(.hidden)", { timeout: 3000 });
    console.log("[test] Artwork preview confirmed visible!");

    // Set variations count to 2
    console.log("[test] Setting variations to 2...");
    const countInput = page.locator("#mockupCount");
    await countInput.fill("2");

    // Set scene prompt directly
    console.log("[test] Setting scene direction prompt...");
    await page.locator("#mockupScenePrompt").fill("Clean studio flatlay on neutral seamless background with soft daylight");

    // Click Generate Mockups button
    console.log("[test] Clicking Generate Mockups button...");
    const generateBtn = page.locator("#mockupGenerateBtn");
    await generateBtn.scrollIntoViewIfNeeded();
    await generateBtn.click({ force: true });

    // Assert that NO unhandled page errors occurred on click!
    if (pageErrors.length > 0) {
      throw new Error(`CRITICAL: Page errors caught on generate click: ${pageErrors.join("; ")}`);
    }

    // Check placeholder cards are created
    console.log("[test] Checking skeleton placeholder cards...");
    await page.waitForSelector("#mockup-slot-0", { timeout: 3000 });
    await page.waitForSelector("#mockup-slot-1", { timeout: 3000 });
    console.log("[test] Placeholder cards #mockup-slot-0 and #mockup-slot-1 verified!");

    // Check progress area is active
    await page.waitForSelector("#mockupProgress:not(.hidden)", { timeout: 3000 });
    console.log("[test] Progress line is active and visible!");

    // Monitor generation loop for up to 120 seconds
    console.log("[test] Monitoring live generation progress...");
    let done = false;
    const startMs = Date.now();
    let lastLoggedPct = "";

    while (!done && Date.now() - startMs < 120000) {
      await page.waitForTimeout(2000);

      const progressText = await page.locator("#mockupProgress span").innerText().catch(() => "");
      const progressWidth = await page.locator("#mockupProgressFill").evaluate((el) => el.style.width).catch(() => "");
      const accountLineText = await page.locator("#mockupAccountLine").innerText().catch(() => "");

      if (progressText !== lastLoggedPct) {
        console.log(`[test-monitor] Progress: ${progressWidth} | ${progressText} | Fleet: ${accountLineText}`);
        lastLoggedPct = progressText;
      }

      // Check if both result cards have completed
      const resolvedCount = await page.locator(".mockup-output-panel .result-card").count();
      if (resolvedCount >= 2) {
        console.log(`[test] SUCCESS! Both mockup result cards rendered into Output Canvas!`);
        done = true;
        break;
      }

      // Check if stopped or failed
      const failedCount = await page.locator(".placeholder-failed").count();
      if (failedCount > 0) {
        console.warn(`[test] Warning: ${failedCount} slot(s) failed or retrying.`);
      }

      // Break if generate button is re-enabled
      const btnDisabled = await generateBtn.isDisabled();
      if (!btnDisabled && resolvedCount > 0) {
        console.log(`[test] Generation finished with ${resolvedCount} output(s).`);
        done = true;
        break;
      }
    }

    // Capture screenshot
    const screenshotPath = path.resolve("mockup-live-test-result.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[test] Screenshot saved to ${screenshotPath}`);

    // Check results count
    const outCountText = await page.locator("#mockupOutCount").innerText();
    console.log(`[test] Output counter reads: ${outCountText}`);

    // Verify DB
    const { getMockups } = await import("../backend/lib/db.js");
    const mockups = getMockups({ limit: 5 });
    console.log(`[test] Database records for 'mockups': ${mockups.rows.length}`);
    if (mockups.rows.length > 0) {
      console.log(`[test] Latest mockup DB row:`, {
        id: mockups.rows[0].id,
        feature: mockups.rows[0].feature,
        output_image_path: mockups.rows[0].output_image_path,
        user_input: mockups.rows[0].user_input,
      });
    }

    console.log("=== LIVE TEST COMPLETED SUCCESSFULLY! ===");
  } finally {
    await browser.close();
    // Cleanup test inputs
    try { fs.unlinkSync(testGarmentPath); } catch (_) {}
    try { fs.unlinkSync(testArtworkPath); } catch (_) {}
  }
}

runLiveTest().catch((err) => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});
