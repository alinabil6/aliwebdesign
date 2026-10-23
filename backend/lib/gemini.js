import zlib from "zlib";
import { pickReadyAccount } from "./accounts.js";
import { getProfilePage, closeProfile, canLaunchBrowser } from "./browser.js";
import * as web from "./geminiweb.js";
import { updateAccountStatus, recordGeneration, setAccountStatus } from "./db.js";
import { registerAccountPage, unregisterAccountPage } from "./queue.js";
import { acquireFleetAccount, release } from "./fleetLease.js";

export const MOCK_GEMINI = process.env.MOCK_GEMINI === "1" || !canLaunchBrowser();

export async function generateImage({ prompt, imagePaths = [] }) {
  if (MOCK_GEMINI || !canLaunchBrowser()) {
    const account = pickReadyAccount();
    if (account) recordGeneration(account.id);
    return mockPng(prompt, imagePaths.length);
  }

  const account = await acquireFleetAccount({ timeoutMs: 30000 });
  if (!account) throw new Error("No Gemini account is ready");

  updateAccountStatus(account.id, { status: "generating" });
  const page = await getProfilePage(account);
  try {
    const result = await web.generateImage({ prompt, imagePaths, page, accountId: account.id });
    recordGeneration(account.id);
    return result;
  } catch (err) {
    if ((err?.message || "").includes("SESSION_EXPIRED")) {
      updateAccountStatus(account.id, { status: "signed_out", last_error: "Session expired — please log in via Accounts tab" });
    } else {
      updateAccountStatus(account.id, { status: "ready", last_error: err.message });
    }
    await page.goto("about:blank", { timeout: 3000 }).catch(() => {});
    throw err;
  } finally {
    await closeProfile(account.id).catch(() => {});
    release(account.id);
  }
}

export async function generateImageOnAccount(account, { prompt, imagePaths = [] }, options = {}) {
  const { signal } = options;
  if (MOCK_GEMINI || !canLaunchBrowser()) {
    if (account?.id) recordGeneration(account.id);
    return mockPng(prompt, imagePaths.length);
  }

  if (signal?.aborted) {
    throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
  }

  setAccountStatus(account.id, "running");
  const page = await getProfilePage(account);

  registerAccountPage(account.id, page, () => {
    try { page.evaluate(() => window.stop()).catch(() => {}); } catch (_) {}
    try { page.goto("about:blank", { timeout: 1000 }).catch(() => {}); } catch (_) {}
  });

  try {
    const result = await web.generateImage({ prompt, imagePaths, page, signal, accountId: account.id });
    recordGeneration(account.id);
    return result;
  } catch (err) {
    const isCancelled = signal?.aborted || err?.name === "AbortError" || (err?.message || "").includes("cancelled by user");
    const isTimeout = (err?.message || "").includes("timed out") || err?.isTimeout;
    if (isCancelled || isTimeout) {
      console.log(`[gemini] Closing profile context for ${account.id} (${isCancelled ? "cancelled" : "timeout"})...`);
      try { await closeProfile(account.id); } catch (_) {}
      if (isCancelled) {
        throw Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" });
      }
    }
    if ((err?.message || "").includes("SESSION_EXPIRED")) {
      console.warn(`[gemini] Marking account ${account.id} as signed_out due to expired session`);
      updateAccountStatus(account.id, { status: "signed_out", last_error: "Session expired — please log in via Accounts tab" });
      try { await closeProfile(account.id); } catch (_) {}
    }
    await page.goto("about:blank", { timeout: 3000 }).catch(() => {});
    throw err;
  } finally {
    unregisterAccountPage(account.id);
  }
}

export function mockPng(prompt = "", imageCount = 1) {
  const width = 512;
  const height = 512;
  const rawData = Buffer.alloc(height * (1 + width * 4));

  let hash = 0;
  const str = String(prompt || "magic-fabrica") + imageCount;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 65) % 360;

  function hsl2rgb(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }

  const [r1, g1, b1] = hsl2rgb(h1, 75, 50);
  const [r2, g2, b2] = hsl2rgb(h2, 85, 60);

  const cx = width / 2;
  const cy = height / 2;
  const maxR = width * 0.44;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // Filter type None
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const px = rowOffset + 1 + x * 4;

      const t = (x + y) / (width + height);
      let r = Math.round(r1 * (1 - t) + r2 * t);
      let g = Math.round(g1 * (1 - t) + g2 * t);
      let b = Math.round(b1 * (1 - t) + b2 * t);

      if (dist <= maxR) {
        const ring = Math.sin(dist / 16);
        if (ring > 0.3) {
          r = Math.min(255, r + 40);
          g = Math.min(255, g + 40);
          b = Math.min(255, b + 40);
        }
      } else {
        const factor = Math.max(0, 1 - (dist - maxR) / 90);
        r = Math.round(r * factor * 0.35);
        g = Math.round(g * factor * 0.35);
        b = Math.round(b * factor * 0.35);
      }

      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
      rawData[px + 3] = 255;
    }
  }

  const compressed = zlib.deflateSync(rawData);

  function crc32(buf) {
    let table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
      table[i] = c;
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
    return (c ^ -1) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    const crc = crc32(Buffer.concat([typeBuf, data]));
    crcBuf.writeUInt32BE(crc, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
