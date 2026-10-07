#!/usr/bin/env node
// ────────────────────────────────────────────────────────────
// scripts/live-composer.mjs — Fast pipeline test runner for
// prompt submission and image buffer extraction without booting
// the web server.
// ────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateImage } from "../backend/lib/gemini.js";
import { closeAll } from "../backend/lib/browser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Parse CLI flags
const args = process.argv.slice(2);
let customPrompt = null;
let outputPath = path.join(ROOT, "tmp", "live-composer-test.png");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--prompt" && args[i + 1]) {
    customPrompt = args[++i];
  } else if (args[i] === "--output" && args[i + 1]) {
    outputPath = path.resolve(args[++i]);
  }
}

const testPrompt =
  customPrompt ||
  "Vintage botanical wildflower illustration of lavender and honeybee, screen-print apparel vector graphic, isolated on solid white background. Zero t-shirt mockups, zero models, zero fabric creases.";

console.log("=================================================");
console.log("   ALIWEBDESIGN: STANDALONE LIVE COMPOSER TEST");
console.log("=================================================");
console.log(`Prompt: "${testPrompt.length > 80 ? testPrompt.slice(0, 77) + "..." : testPrompt}"`);
console.log(`Target Output: ${outputPath}`);

async function run() {
  const startTime = performance.now();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    console.log("\n[1/3] Dispatching prompt to generation engine...");
    const buffer = await generateImage({
      prompt: testPrompt,
      imagePaths: [],
    });

    const elapsedMs = Math.round(performance.now() - startTime);

    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("Pipeline returned empty or non-buffer data.");
    }

    // Check PNG signature [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;

    console.log("\n[2/3] Validating extracted artwork buffer...");
    console.log(`  • Buffer Size      : ${(buffer.length / 1024).toFixed(2)} KB (${buffer.length} bytes)`);
    console.log(`  • Valid PNG Header : ${isPng ? "✓ Verified PNG signature" : "✗ Unknown header"}`);
    console.log(`  • Pipeline Latency : ${elapsedMs} ms`);

    console.log("\n[3/3] Evacuating buffer to disk and releasing memory...");
    await fs.promises.writeFile(outputPath, buffer);
    console.log(`  • Saved to disk    : ${outputPath}`);

    console.log("\n=================================================");
    console.log(`✓ Live composer test PASSED in ${elapsedMs} ms.`);
    console.log("=================================================");
  } catch (err) {
    console.error("\n✗ Live composer test FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    await closeAll().catch(() => {});
  }
}

run();
