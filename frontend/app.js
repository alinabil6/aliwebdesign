/* ALIWEBDESIGN — Complete Frontend Studio */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function renderIcons() {
  if (window.lucide) lucide.createIcons();
}

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

async function api(url, opts = {}) {
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const res = await fetch(url, {
    ...(isForm ? {} : { headers: { "Content-Type": "application/json" } }),
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ── Design Shape / Aspect Ratio Definitions ─────────────── */
const ASPECT_RATIOS = [
  { id: "1:1", label: "1:1", name: "1:1 Square", previewClass: "ratio-1-1" },
  { id: "9:16", label: "9:16", name: "9:16 Vertical Story", previewClass: "ratio-9-16" },
  { id: "3:4", label: "3:4", name: "3:4 Portrait", previewClass: "ratio-3-4" },
  { id: "4:3", label: "4:3", name: "4:3 Landscape", previewClass: "ratio-4-3" },
  { id: "16:9", label: "16:9", name: "16:9 Widescreen", previewClass: "ratio-16-9" },
  { id: "4:5", label: "4:5", name: "4:5 Print Portrait", previewClass: "ratio-4-5" },
];

function renderShapeSelector(prefix, activeId = "1:1") {
  return `
    <div class="field shape-field">
      <div class="stage-head">
        <span class="field-label">Design shape</span>
        <span class="stage-counter" id="${prefix}ShapeLabel">${ASPECT_RATIOS.find((r) => r.id === activeId)?.name || "1:1 Square"}</span>
      </div>
      <div class="shape-row" id="${prefix}Shapes">
        ${ASPECT_RATIOS.map((r) => `
          <button type="button" class="shape-btn ${r.id === activeId ? "active" : ""}" data-ratio="${r.id}" title="${r.name}">
            <span class="shape-preview ${r.previewClass}"></span>
            <span class="shape-text">${r.label}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function bindShapeSelector(prefix, onChange) {
  const buttons = $$(`#${prefix}Shapes .shape-btn`);
  const label = $(`#${prefix}ShapeLabel`);
  let selected = "1:1";
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selected = btn.dataset.ratio || "1:1";
      if (label) {
        label.textContent = ASPECT_RATIOS.find((r) => r.id === selected)?.name || selected;
      }
      if (typeof onChange === "function") onChange(selected);
    });
  });
  return () => selected;
}

/* ── Unified Continuous Progress Tracker ────────────────────
   One engine drives every generation/listing tab's progress bar. Each item
   (design, pair, or single batch) gets its own simulated progress curve that
   climbs through realistic stages — upload → account/browser prep → model
   generation → buffer extraction — so the bar never freezes during the
   ~50s backend execution. finishItem() snaps an item to 100% and the
   aggregate is averaged across totalItems. Text-mode (Magic Listing) uses a
   faster ~8s curve; image generation uses ~48s. */
class GenerationProgressTracker {
  constructor({ barEl, labelEl, totalItems = 1, isTextMode = false }) {
    this.barEl = barEl;
    this.labelEl = labelEl;
    this.totalItems = Math.max(1, totalItems);
    this.isTextMode = isTextMode;
    this.items = new Map();
    this.startTime = Date.now();
    const initLine = this.labelEl ? this.labelEl.closest(".progress-line") : null;
    if (initLine) {
      initLine.classList.remove("is-complete", "is-stopped");
      const ic = initLine.querySelector("svg, i");
      if (ic && !ic.classList.contains("lucide-refresh-cw")) {
        ic.outerHTML = '<i data-lucide="refresh-cw"></i>';
        if (typeof renderIcons === "function") renderIcons();
      }
    }
    this.finalElapsed = null;

    // Smooth 500ms ticker for the MM:SS stopwatch
    this.clockInterval = setInterval(() => {
      this._render();
    }, 500);
  }

  formatTime(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  }

  startItem(id) {
    const startTime = Date.now();
    this.items.set(id, { pct: 5, finished: false });
    this._render();

    const targetDuration = this.isTextMode ? 8 : 48;

    const interval = setInterval(() => {
      const item = this.items.get(id);
      if (!item || item.finished) {
        clearInterval(interval);
        return;
      }

      const elapsed = (Date.now() - startTime) / 1000;
      let calculatedPct = 5;

      if (elapsed < 3) {
        calculatedPct = 5 + (elapsed / 3) * 15;
      } else if (elapsed < 12) {
        calculatedPct = 20 + ((elapsed - 3) / 9) * 25;
      } else if (elapsed < targetDuration) {
        calculatedPct = 45 + ((elapsed - 12) / (targetDuration - 12)) * 43;
      } else {
        calculatedPct = Math.min(95, 88 + (elapsed - targetDuration) * 0.4);
      }

      item.pct = Math.round(calculatedPct);
      this._render();
    }, 250);

    return () => clearInterval(interval);
  }

  finishItem(id) {
    const item = this.items.get(id);
    if (item) {
      item.pct = 100;
      item.finished = true;
    }
    this._render();
  }

  /** Alias for finishItem — snaps an item to 100% and marks it done. */
  completeItem(id) {
    this.finishItem(id);
  }

  _render() {
    let totalPct = 0;
    let doneCount = 0;
    this.items.forEach((item) => {
      totalPct += item.pct;
      if (item.finished) doneCount++;
    });

    const aggregatePct = Math.min(100, Math.round(totalPct / this.totalItems));
    const timeDisplay = this.finalElapsed || this.formatTime(Date.now() - this.startTime);

    if (this.barEl) {
      this.barEl.style.width = `${aggregatePct}%`;
    }

    if (this.labelEl) {
      let stageText = "Processing...";
      if (aggregatePct < 20) stageText = "Uploading reference assets…";
      else if (aggregatePct < 45) stageText = "Connecting account & preparing browser…";
      else if (aggregatePct < 85) stageText = this.isTextMode ? "Crafting listing & keywords…" : "Generating illustration with Gemini…";
      else if (aggregatePct < 98) stageText = "Extracting & finalizing output…";
      else stageText = "Complete!";

      const itemInfo = this.totalItems > 1 ? ` (${doneCount}/${this.totalItems})` : "";
      this.labelEl.textContent = `${stageText}${itemInfo} (${aggregatePct}%) • ⏱ ${timeDisplay}`;
    }
  }

  completeAll() {
    if (!this.finalElapsed) {
      this.finalElapsed = this.formatTime(Date.now() - this.startTime);
    }
    if (this.clockInterval) clearInterval(this.clockInterval);
    if (this.barEl) this.barEl.style.width = "100%";
    const completeLine = this.labelEl ? this.labelEl.closest(".progress-line") : null;
    if (completeLine) {
      completeLine.classList.remove("is-stopped");
      completeLine.classList.add("is-complete");
      const ic = completeLine.querySelector("svg, i");
      if (ic) {
        ic.outerHTML = '<i data-lucide="check-circle-2"></i>';
        if (typeof renderIcons === "function") renderIcons();
      }
    }
    if (this.labelEl) {
      this.labelEl.textContent = `All designs generated! (100%) • ⏱ ${this.finalElapsed}`;
    }
  }

  stop() {
    if (this.clockInterval) clearInterval(this.clockInterval);
    this.items.clear();
    const stopLine = this.labelEl ? this.labelEl.closest(".progress-line") : null;
    if (stopLine) {
      stopLine.classList.remove("is-complete");
      stopLine.classList.add("is-stopped");
      const ic = stopLine.querySelector("svg, i");
      if (ic) {
        ic.outerHTML = '<i data-lucide="x-circle"></i>';
        if (typeof renderIcons === "function") renderIcons();
      }
    }
  }
}

/* ── Streaming Placeholder Helpers ─────────────────────────
   renderPlaceholders() mounts N skeleton cards the instant Generate is
   clicked; resolvePlaceholder() swaps a finished design into its exact slot
   (replaceWith) as it streams back; failPlaceholder() marks a slot failed.
   fetchStreamNDJSON() consumes the backend's NDJSON chunked response and
   calls onChunk for every { event, slotIndex, design } line. */

let placeholderTicker = null;

function renderPlaceholders(containerEl, count, prefix = "slot") {
  if (!containerEl) return;
  const startTime = Date.now();
  const cardsHtml = Array.from({ length: count }, (_, i) => `
    <div class="card-placeholder" id="${prefix}-${i}" data-slot-index="${i}" data-start-time="${startTime}">
      <div class="placeholder-spinner-wrap">
        <i data-lucide="refresh-cw" class="placeholder-spinner"></i>
        <span class="placeholder-label">Generating design…</span>
        <div style="display:inline-flex;align-items:center;gap:6px;margin-top:2px;">
          <span class="placeholder-slot-badge">#${i + 1} of ${count}</span>
          <span class="placeholder-timer-badge" style="font-size:0.72rem;background:rgba(56,189,248,0.12);color:#38bdf8;padding:2px 8px;border-radius:9999px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-weight:600;">⏱ 00:00</span>
        </div>
      </div>
    </div>
  `).join("");
  containerEl.innerHTML = cardsHtml;
  renderIcons();

  if (placeholderTicker) clearInterval(placeholderTicker);
  placeholderTicker = setInterval(() => {
    const slots = document.querySelectorAll(".card-placeholder[data-start-time]");
    if (slots.length === 0) {
      clearInterval(placeholderTicker);
      placeholderTicker = null;
      return;
    }
    const now = Date.now();
    slots.forEach((slot) => {
      const start = Number(slot.dataset.startTime) || now;
      const totalSec = Math.max(0, Math.floor((now - start) / 1000));
      const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
      const secs = String(totalSec % 60).padStart(2, "0");
      const badge = slot.querySelector(".placeholder-timer-badge");
      if (badge) badge.textContent = `⏱ ${mins}:${secs}`;
    });
  }, 500);
}

function resolvePlaceholder(slotId, design) {
  const placeholder = document.getElementById(slotId);
  if (!placeholder) return;
  const startTime = Number(placeholder.dataset.startTime) || null;
  if (startTime && !design.generation_time) {
    const totalSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const secs = String(totalSec % 60).padStart(2, "0");
    design.generation_time = `${mins}:${secs}`;
  }
  const temp = document.createElement("div");
  temp.innerHTML = resultCard(design);
  const cardEl = temp.firstElementChild;
  if (cardEl) {
    cardEl.classList.add("card-fade-in");
    placeholder.replaceWith(cardEl);
    renderIcons();
  }
}

function failPlaceholder(slotId, reason = "Failed") {
  const placeholder = document.getElementById(slotId);
  if (!placeholder || placeholder.classList.contains("placeholder-failed")) return;
  const startTime = Number(placeholder.dataset.startTime) || null;
  placeholder.removeAttribute("data-start-time"); // Freeze timer
  let elapsedSuffix = "";
  if (startTime) {
    const totalSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const secs = String(totalSec % 60).padStart(2, "0");
    elapsedSuffix = ` • ⏱ ${mins}:${secs}`;
  }
  placeholder.classList.add("placeholder-failed");
  placeholder.innerHTML = `
    <div class="placeholder-spinner-wrap">
      <i data-lucide="alert-circle" style="color: #ef4444; width: 32px; height: 32px; margin-bottom: 4px;"></i>
      <span class="placeholder-label" style="color: #ef4444; font-weight: 600; font-size: 0.95rem;">Generation failed</span>
      <div style="display:inline-flex;align-items:center;gap:6px;margin-top:6px;">
        <span class="placeholder-slot-badge" style="color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); background: rgba(239, 68, 68, 0.12); font-weight: 500; font-size: 0.72rem; padding: 2px 10px; border-radius: 9999px;">
          ${esc(reason)}${elapsedSuffix}
        </span>
      </div>
    </div>
  `;
  renderIcons();
}

function cancelAllPlaceholders(containerEl, reason = "Cancelled") {
  const root = containerEl || document;
  root.querySelectorAll(".card-placeholder:not(.placeholder-failed)").forEach((slot) => {
    failPlaceholder(slot.id, reason);
  });
}

async function fetchStreamNDJSON(url, options, onChunk) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "Accept": "application/x-ndjson",
    },
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Retain incomplete chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const payload = JSON.parse(trimmed);
        onChunk(payload);
        if (payload.event === "design") {
          refreshAccountsData();
        }
      } catch (err) {
        console.warn("Failed to parse NDJSON chunk:", line, err);
      }
    }
  }

  if (buffer.trim()) {
    try {
      const payload = JSON.parse(buffer.trim());
      onChunk(payload);
      if (payload.event === "design") {
        refreshAccountsData();
      }
    } catch { /* ignore trailing partial */ }
  }
  refreshAccountsData();
}

/** Resolve a File to a base64 data URL. readAsDataURL returns void — the
 *  bytes land on reader.result via onload, so the Promise wrapper is what
 *  actually waits for the read to finish. */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Downscale + re-encode a File for AI vision inspection (~200-600KB JPEG).
 *  High-resolution print files (>15MB) balloon past the server body limit
 *  when sent as raw base64 — this keeps the payload small while preserving
 *  enough detail for Gemini to read the design. */
function optimizeImageForVision(file, maxDimension = 1200) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        // Export optimized JPEG/PNG base64 (~200KB-600KB)
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Downscale a File to a lightweight thumbnail proxy for style analysis.
 *  Max 512px on the longest side, JPEG 0.8 — keeps the whole batch under
 *  ~500KB so /api/magic-style-analyze round-trips in well under 30s. */
function downscaleForStyleAnalysis(file, maxDimension = 512) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ── Clipboard Paste (Ctrl+V) — shared dropzone wiring ─────── */

/* ── Global Unified Drop & Paste Intake System ──────────────── */

let lastHoveredDropzone = null;
let lastActiveDropzone = null;

function setActiveDropzone(dz) {
  if (!dz || !dz.isConnected || dz.closest(".hidden")) return;
  lastActiveDropzone = dz;

  // Visual outline on active dropzone target
  document.querySelectorAll(".dropzone-active-target").forEach((el) => {
    if (el !== dz) el.classList.remove("dropzone-active-target");
  });
  dz.classList.add("dropzone-active-target");

  // If inside an as-side column, mark the side container too
  const side = dz.closest(".as-side");
  document.querySelectorAll(".as-side.side-active-target").forEach((el) => {
    if (el !== side) el.classList.remove("side-active-target");
  });
  if (side) side.classList.add("side-active-target");
}

// Track dropzone hover state for mouse-targeted drop/paste operations
document.addEventListener("mouseover", (e) => {
  const dz = e.target.closest?.(
    ".multi-dropzone, .prepare-drop-area, .app-dropzone, #p2pDropZone, #d2dDrop, #nvDrop, #prepDrop, #asDropStyle, #asDropNiche, #mlDrop, #mlRefDrop"
  );
  if (dz) {
    lastHoveredDropzone = dz;
    setActiveDropzone(dz);
  }
});

// Track click/focus on dropzones or their parent stage cards so clipboard pastes go to the clicked slot
document.addEventListener("mousedown", (e) => {
  const dz = e.target.closest?.(
    ".multi-dropzone, .prepare-drop-area, .app-dropzone, #p2pDropZone, #d2dDrop, #nvDrop, #prepDrop, #asDropStyle, #asDropNiche, #mlDrop, #mlRefDrop"
  );
  if (dz) {
    setActiveDropzone(dz);
  } else {
    const asSide = e.target.closest?.(".as-side");
    if (asSide) {
      const sideDz = asSide.querySelector(".multi-dropzone");
      if (sideDz) setActiveDropzone(sideDz);
    }
  }
});

/**
 * Extract image files from clipboard data items or files.
 * Handles screenshots (Win + Shift + S), right-click copied images, and pasted file references.
 */
function extractImagesFromClipboard(clipboardData) {
  const images = [];
  if (!clipboardData) return images;

  // 1. First probe items list (contains in-memory image bitmaps from screenshots/browser copy)
  const items = clipboardData.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && (item.type?.startsWith("image/") || item.kind === "file")) {
        const blob = item.getAsFile();
        if (blob && blob.type?.startsWith("image/")) {
          const ext = blob.type.split("/")[1]?.replace("+xml", "") || "png";
          const file = new File([blob], `pasted-image-${Date.now()}-${i + 1}.${ext}`, {
            type: blob.type || "image/png",
            lastModified: Date.now(),
          });
          images.push(file);
        }
      }
    }
  }

  // 2. If no items extracted, check clipboardData.files (files copied in explorer/desktop)
  if (!images.length && clipboardData.files && clipboardData.files.length > 0) {
    for (const f of clipboardData.files) {
      if (f.type && f.type.startsWith("image/")) {
        images.push(f);
      }
    }
  }

  return images;
}

/**
 * Resolve the appropriate dropzone for an incoming paste:
 * 1. Currently hovered dropzone (if active and inside current section)
 * 2. Last active/clicked dropzone in current section (persists across OS clipboard popups)
 * 3. Element inside dropzone or side column that currently has focus
 * 4. First visible dropzone in currently active section
 */
function resolvePasteDropzone() {
  const activeSection = document.querySelector("#view > .app-section:not(.hidden)");

  // 1. If currently hovering a connected, visible dropzone inside active section
  if (lastHoveredDropzone && lastHoveredDropzone.isConnected && !lastHoveredDropzone.closest(".hidden")) {
    if (!activeSection || activeSection.contains(lastHoveredDropzone)) {
      return lastHoveredDropzone;
    }
  }

  // 2. If the user previously clicked or hovered a dropzone in this section
  if (lastActiveDropzone && lastActiveDropzone.isConnected && !lastActiveDropzone.closest(".hidden")) {
    if (!activeSection || activeSection.contains(lastActiveDropzone)) {
      return lastActiveDropzone;
    }
  }

  // 3. If an element inside a dropzone or its side-wrapper has focus
  if (document.activeElement) {
    const focusedDz = document.activeElement.closest?.(
      ".app-dropzone, .multi-dropzone, .prepare-drop-area, #p2pDropZone, #d2dDrop, #nvDrop, #prepDrop, #asDropStyle, #asDropNiche, #mlDrop"
    );
    if (focusedDz && focusedDz.isConnected && !focusedDz.closest(".hidden")) {
      return focusedDz;
    }
  }

  // 4. Default to the first dropzone in currently visible section
  if (activeSection) {
    const dz = activeSection.querySelector(
      ".app-dropzone, .multi-dropzone, .prepare-drop-area, #p2pDropZone, #d2dDrop, #nvDrop, #prepDrop, #asDropStyle, #asDropNiche, #mlDrop"
    );
    if (dz && !dz.closest(".hidden")) return dz;
  }

  // Fallback: search anywhere across the DOM for the first visible dropzone
  const candidateDropzones = document.querySelectorAll(
    "#p2pDropZone, #d2dDrop, #nvDrop, #prepDrop, #asDropStyle, #asDropNiche, #mlDrop, .app-dropzone, .multi-dropzone, .prepare-drop-area"
  );

  for (const dz of candidateDropzones) {
    if (dz.isConnected && !dz.closest(".hidden") && dz.offsetParent !== null) {
      return dz;
    }
  }

  return null;
}

/**
 * Route files into a dropzone via its direct processor callback,
 * or through its hidden input via DataTransfer, or via custom event.
 */
function pasteFilesIntoDropzone(dropzone, files) {
  if (!dropzone || !files || !files.length) return;

  // Visual pulse on successful paste
  dropzone.classList.remove("paste-active");
  void dropzone.offsetWidth;
  dropzone.classList.add("paste-active");
  setTimeout(() => dropzone.classList.remove("paste-active"), 1400);

  // 1. Direct handler registered via bindDropAndPasteZone
  if (typeof dropzone._onFileReceived === "function") {
    dropzone._onFileReceived(files);
    return;
  }

  // 2. Route via hidden input element
  const input = dropzone._inputEl || dropzone.querySelector('input[type="file"]');
  if (input) {
    try {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      dropzone.dispatchEvent(new CustomEvent("paste-files", { detail: files }));
    }
  } else {
    dropzone.dispatchEvent(new CustomEvent("paste-files", { detail: files }));
  }
}

/**
 * Standard reusable drop and paste zone binder.
 * Wires dragenter, dragover, dragleave, drop, click-to-browse, and paste support.
 */
function bindDropAndPasteZone({
  dropzoneEl,
  inputEl,
  onFileReceived,
  allowedMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/avif", "image/gif"]
}) {
  if (!dropzoneEl) return;

  dropzoneEl.classList.add("app-dropzone");
  dropzoneEl._onFileReceived = onFileReceived;
  dropzoneEl._inputEl = inputEl;

  // Track hover and active state for targeted pasting
  dropzoneEl.addEventListener("mouseenter", () => {
    lastHoveredDropzone = dropzoneEl;
    setActiveDropzone(dropzoneEl);
  });
  dropzoneEl.addEventListener("mouseleave", () => {
    if (lastHoveredDropzone === dropzoneEl) lastHoveredDropzone = null;
  });
  dropzoneEl.addEventListener("mousedown", () => {
    setActiveDropzone(dropzoneEl);
  });

  // Click-to-browse
  if (inputEl) {
    dropzoneEl.addEventListener("click", (e) => {
      if (e.target === inputEl || e.target.closest("button, a, input, textarea")) return;
      inputEl.click();
    });

    inputEl.addEventListener("change", () => {
      if (inputEl.files && inputEl.files.length) {
        const filesArray = Array.from(inputEl.files);
        if (typeof onFileReceived === "function") {
          onFileReceived(filesArray);
        }
      }
    });
  }

  // Drag and Drop
  let dragCounter = 0;

  dropzoneEl.addEventListener("dragenter", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    dropzoneEl.classList.add("drag-over", "drag");
  });

  dropzoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    dropzoneEl.classList.add("drag-over", "drag");
  });

  dropzoneEl.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      dropzoneEl.classList.remove("drag-over", "drag");
    }
  });

  dropzoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    dropzoneEl.classList.remove("drag-over", "drag");

    const rawFiles = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (!rawFiles.length) return;

    const validFiles = rawFiles.filter((f) => {
      if (!allowedMimeTypes || allowedMimeTypes.length === 0) return true;
      return allowedMimeTypes.some((mime) => {
        if (mime.endsWith("/*")) {
          return f.type?.startsWith(mime.slice(0, -1));
        }
        return f.type === mime || f.type?.startsWith("image/");
      });
    });

    if (validFiles.length > 0) {
      if (typeof onFileReceived === "function") {
        onFileReceived(validFiles);
      }
      dropzoneEl.classList.add("paste-active");
      setTimeout(() => dropzoneEl.classList.remove("paste-active"), 1200);
    }
  });

  // Custom paste-files event support
  dropzoneEl.addEventListener("paste-files", (e) => {
    const files = e.detail;
    if (files && files.length && typeof onFileReceived === "function") {
      onFileReceived(files);
    }
  });
}

// Global window paste handler
window.addEventListener("paste", (e) => {
  // Never hijack paste when user is typing inside text fields or code areas
  const target = e.target;
  if (target && target.closest?.("input:not([type='file']), textarea, [contenteditable='true']")) {
    return;
  }

  const images = extractImagesFromClipboard(e.clipboardData);
  if (!images.length) return;

  const dropzone = resolvePasteDropzone();
  if (!dropzone) return;

  e.preventDefault();
  pasteFilesIntoDropzone(dropzone, images);
});

/* ── Magic Style (auto style picker) — shared wiring ────────── */

const MAGIC_STYLE_BTN_DEFAULT = '<i data-lucide="sparkles"></i> Magic Style — Auto Pick';
const MAGIC_STYLE_BTN_REROLL = '<i data-lucide="refresh-cw"></i> Re-roll Style';
const MAGIC_STYLE_BTN_LOADING = '<i data-lucide="sparkles" class="spinning"></i> Analyzing best style...';

/**
 * Wire the Magic Style button + badge inside a view container.
 * Returns { get, clear } — get() yields the active style or null.
 */
function setupMagicStyle({ btn, container, getContext, onPick, onStyle }) {
  let activeMagicStyle = null;

  const renderBadge = () => {
    container.querySelector(".magic-style-badge")?.remove();
    if (!activeMagicStyle) return;
    const badge = document.createElement("div");
    badge.className = "magic-style-badge";
    badge.innerHTML = `<span class="badge-tag">✨ Style:</span> <span class="badge-name">${esc(activeMagicStyle.name)}</span>
      <button type="button" class="badge-remove" title="Remove style">✕</button>`;
    badge.querySelector(".badge-remove").addEventListener("click", () => clear());
    container.appendChild(badge);
  };

  // When auto-pick lands on a style, also reflect its name into the manual
  // style input so the user can inspect or edit it before generating.
  const reflectStyle = (style) => {
    if (typeof onStyle === "function" && style?.name) onStyle(style.name);
  };

  async function pick() {
    const { prompt, imageFile } = getContext();
    if (!prompt && !imageFile) {
      alert("Add a prompt or upload a design first so Magic Style has context.");
      return;
    }

    btn.classList.add("loading");
    btn.disabled = true;
    btn.innerHTML = MAGIC_STYLE_BTN_LOADING;
    renderIcons();

    try {
      if (typeof onPick === "function") {
        // Custom picker (e.g. Niche Variations' per-design batch analysis) —
        // runs ONLY on this button click, never on upload.
        const style = await onPick();
        if (style) {
          activeMagicStyle = style;
          renderBadge();
          reflectStyle(style);
          btn.innerHTML = MAGIC_STYLE_BTN_REROLL;
        } else {
          btn.innerHTML = activeMagicStyle ? MAGIC_STYLE_BTN_REROLL : MAGIC_STYLE_BTN_DEFAULT;
        }
      } else {
        let res;
        if (imageFile) {
          const fd = new FormData();
          fd.append("image", imageFile);
          if (prompt) fd.append("prompt", prompt);
          res = await api("/api/styles/magic-suggest", { method: "POST", body: fd });
        } else {
          res = await api("/api/styles/magic-suggest", {
            method: "POST",
            body: JSON.stringify({ prompt }),
          });
        }

        activeMagicStyle = res.style || null;
        renderBadge();
        reflectStyle(activeMagicStyle);
        btn.innerHTML = MAGIC_STYLE_BTN_REROLL;
      }
    } catch (err) {
      alert("Magic Style failed: " + err.message);
      btn.innerHTML = activeMagicStyle ? MAGIC_STYLE_BTN_REROLL : MAGIC_STYLE_BTN_DEFAULT;
    } finally {
      btn.classList.remove("loading");
      btn.disabled = false;
      renderIcons();
    }
  }

  function clear() {
    activeMagicStyle = null;
    container.querySelector(".magic-style-badge")?.remove();
    btn.innerHTML = MAGIC_STYLE_BTN_DEFAULT;
    renderIcons();
  }

  btn.addEventListener("click", pick);

  return {
    get: () => activeMagicStyle,
    clear,
  };
}

/** Append the active style fields to a FormData payload. */
function appendMagicStyle(fd, style) {
  if (!style) return;
  fd.append("style_id", style.id);
  fd.append("style_name", style.name);
  fd.append("style_directive", style.directive);
}

/** Append the active style fields to a JSON payload object. */
function withMagicStyle(payload, style) {
  if (!style) return payload;
  return { ...payload, style_id: style.id, style_name: style.name, style_directive: style.directive };
}

/* ── Per-Design Magic Style Analysis ─────────────────────── */

/**
 * Analyze every uploaded design against the +60 style taxonomy.
 * POSTs all images in one multipart request; the server fans out to the
 * pooled account engine in parallel and returns analyses aligned with
 * upload order. Each analysis: { designIndex, primaryStyle, alternativeStyles,
 * visualKeypoints, commercialNicheAngle }.
 */
async function analyzeDesigns(files, onProgress) {
  if (!files.length) return [];
  // Downscale every design to a ≤512px JPEG proxy first — the full-res
  // originals can be 15MB+ each, which would blow past the 30s budget and
  // the server body limit. The proxy keeps the whole batch <500KB.
  const proxies = await Promise.all(
    files.map((f) => downscaleForStyleAnalysis(f).catch(() => null))
  );
  const fd = new FormData();
  proxies.forEach((p) => {
    if (p) fd.append("images", dataUrlToBlob(p));
  });
  if (!fd.has("images")) return [];
  const res = await api("/api/styles/magic-style-analyze", { method: "POST", body: fd });
  const analyses = res.analyses || [];
  if (typeof onProgress === "function") onProgress(analyses.length);
  return analyses;
}

/** Convert a data URL to a Blob for FormData upload. */
function dataUrlToBlob(dataUrl) {
  const [head, base64] = dataUrl.split(",");
  const mime = (head.match(/data:(.*?);/) || [])[1] || "image/jpeg";
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Render the per-design style badge overlaid on the thumbnail.
 *  `analyzing` forces the skeleton "Analyzing…" state (only shown while a
 *  manual Magic Style run is in flight); a `null` analysis renders nothing —
 *  uploads stay idle until the user clicks "Magic Style — Auto Pick". */
function styleBadgeHtml(analysis, analyzing = false) {
  if (analyzing) {
    return `<span class="thumb-style-badge skeleton" title="Analyzing style…"><i data-lucide="loader"></i> Analyzing…</span>`;
  }
  if (!analysis) {
    return ""; // idle — no badge until Magic Style is run
  }
  const name = esc(analysis.primaryStyle?.name || "Style");
  // title carries the FULL style name — the badge truncates visually, hover
  // reveals the complete text in a browser tooltip without cluttering.
  return `<button type="button" class="thumb-style-badge" data-style-pop="${esc(analysis.designIndex)}" title="${name}">
    <i data-lucide="wand-2"></i> ${name}
  </button>`;
}

/** Popover card detailing a design's primary style + alternatives. */
function stylePopoverHtml(analysis) {
  if (!analysis) return "";
  const primary = analysis.primaryStyle || {};
  const alts = analysis.alternativeStyles || [];
  const keypoints = analysis.visualKeypoints || [];
  return `
    <div class="style-popover" data-style-pop="${esc(analysis.designIndex)}">
      <div class="style-pop-head">
        <span class="style-pop-title">Primary style</span>
        <button type="button" class="style-pop-close" title="Close"><i data-lucide="x"></i></button>
      </div>
      <p class="style-pop-name">${esc(primary.name || "—")}</p>
      <p class="style-pop-desc">${esc(primary.description || "")}</p>
      ${alts.length ? `
        <div class="style-pop-alts">
          <span class="style-pop-label">Swap to:</span>
          ${alts.map((a) => `
            <button type="button" class="style-alt-chip" data-alt-id="${esc(a.id)}" data-alt-name="${esc(a.name)}">${esc(a.name)}</button>
          `).join("")}
        </div>` : ""}
      ${keypoints.length ? `
        <ul class="style-pop-keypoints">
          ${keypoints.map((k) => `<li>${esc(k)}</li>`).join("")}
        </ul>` : ""}
      ${analysis.commercialNicheAngle ? `<p class="style-pop-niche">${esc(analysis.commercialNicheAngle)}</p>` : ""}
    </div>`;
}

/* ── Live Top Bar Health & Real-time Account Auto-Refresh ───── */

let accountsEventSource = null;
let accountsDirty = false;
let isRefreshingAccounts = false;

async function refreshAccountsData() {
  refreshTopBar();
  const accountsSection = document.getElementById("section-accounts");
  const isAccountsVisible = accountsSection && !accountsSection.classList.contains("hidden");
  if (isAccountsVisible) {
    if (typeof renderAccounts === "function" && !isRefreshingAccounts) {
      isRefreshingAccounts = true;
      try {
        await renderAccounts();
      } finally {
        isRefreshingAccounts = false;
      }
    }
  } else {
    accountsDirty = true;
  }
}
window.refreshAccountsData = refreshAccountsData;

function initAccountsEventStream() {
  if (accountsEventSource) return;
  try {
    accountsEventSource = new EventSource("/api/accounts/events");
    accountsEventSource.addEventListener("account_change", () => {
      refreshAccountsData();
    });
    accountsEventSource.onerror = () => {
      // Browser EventSource automatically reconnects on error
    };
  } catch (err) {
    console.warn("[accounts] EventSource setup failed:", err);
  }
}
window.initAccountsEventStream = initAccountsEventStream;

async function refreshTopBar() {
  const dot = $("#topStatusDot");
  const text = $("#topStatusText");
  if (!dot || !text) return;
  try {
    const data = await api("/api/accounts");
    const list = data.accounts || [];
    const ready = list.filter((a) => a.status === "ready").length;
    text.textContent = `${ready} of ${list.length} accounts ready`;
    dot.className = "top-dot";
    if (ready === list.length && list.length > 0) {
      dot.classList.add("ok");
    } else if (ready > 0) {
      dot.classList.add("warn");
    } else {
      dot.classList.add("bad");
    }
  } catch {
    text.textContent = "Accounts offline";
    dot.className = "top-dot bad";
  }
}

/* ── View Router ─────────────────────────────────────────── */

const views = {
  home: renderHome,
  t2i: renderTextToImage,
  variations: renderVariations,
  d2d: renderDesignToDesign,
  p2p: renderPixelToPixel,
  magicListing: renderMagicListing,
  artstyle: renderArtStyleNiche,
  designs: renderDesigns,
  accounts: renderAccounts,
  "pixel-to-pixel": renderPixelToPixel,
  "prepare": renderPrepareDesigns,
};

// A view that starts a timer or a poll registers its teardown here, so leaving
// the view cancels it before the next render swaps #view's contents out from
// under it. Only one view is mounted at a time, so one slot is enough.
let viewTeardown = null;

// Views are mounted ONCE into persistent section containers (#section-<name>)
// and then toggled via the .hidden class — never unmounted or wiped on
// navigation. Uploaded designs, selected styles, generated previews, and
// running batches survive tab switches; only an explicit browser reload
// clears them. Render functions target their own section by ID.
const mountedViews = new Set();

/** Get (creating on first use) the persistent section container for a view. */
function viewMount(name) {
  let el = document.getElementById(`section-${name}`);
  if (!el) {
    el = document.createElement("div");
    el.id = `section-${name}`;
    el.className = name === "home" ? "app-section" : "app-section aura-content view-section";
    $("#view").appendChild(el);
  }
  return el;
}


/* ── Pixel to Pixel Workspace ───────────────────────────────── */
function renderPixelToPixel() {
  let sourceFiles = [];
  let selectedBg = "#FFFFFF";
  let abortController = null;
  let generatedResults = [];
  let accountPoll = null;
  // Hoisted so the Stop handler can mark every pending slot and stop the
  // progress engine without re-reading the DOM.
  let activeTotalSlots = 0;
  let tracker = null;

  const bgPalette = [
    { color: "transparent", label: "Transparent" },
    { color: "#FFFFFF", label: "White" },
    { color: "#111827", label: "Dark Gray" },
    { color: "#000000", label: "Black" },
    { color: "#F5EBE0", label: "Cream" },
    { color: "#1E3A8A", label: "Navy" },
    { color: "#14532D", label: "Forest Green" },
    { color: "#C2410C", label: "Rust Orange" }
  ];

  viewMount("pixel-to-pixel").innerHTML = `
    <div class="view" style="max-width: 1280px; margin: 0 auto; padding-bottom: 3rem;">
      <header class="view-header" style="margin-bottom: 1.5rem;">
        <div>
          <h1 class="page-title" style="display: flex; align-items: center; gap: 0.6rem; font-size: 1.4rem;">
            <i data-lucide="wand-2" style="color: #3b82f6;"></i> Pixel to Pixel
          </h1>
          <p class="view-sub" style="margin-top: 0.2rem; font-size: 0.85rem;">
            Multi-canvas — upload up to 100 source designs and redraw each into a clean, print-ready version with strict composition preservation.
          </p>
        </div>
      </header>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; margin-bottom: 1.25rem;">
        <div class="card" style="background: var(--bg-surface, var(--color-panel, #ffffff)); border: 1px solid var(--color-border, transparent); border-radius: 18px; padding: 1.5rem; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.85rem;">
            <span style="font-weight: 600; font-size: 0.95rem; color: var(--color-text, currentColor);">Your designs</span>
            <span id="p2pCounterBadge" style="font-size: 0.8rem; color: #94a3b8; font-weight: 500;">0 / 100</span>
          </div>

          <div class="prepare-drop-area" id="p2pDropZone" style="margin: 0 0 1rem 0; padding: 2.75rem 1.5rem; border: 1.5px dashed rgba(59, 130, 246, 0.35); border-radius: 14px; background: rgba(59, 130, 246, 0.02); text-align: center; cursor: pointer;">
            <i data-lucide="upload-cloud" style="width: 32px; height: 32px; opacity: 0.6; margin-bottom: 0.4rem;"></i>
            <p style="margin: 0.25rem 0; font-size: 0.92rem; font-weight: 500;">Drop designs here or click to browse</p>
            <p class="prepare-meta-hint" style="margin: 0; font-size: 0.78rem;">Gets a clean, print-ready redraw of each · or press <kbd>Ctrl</kbd> + <kbd>V</kbd> to paste</p>
            <input type="file" id="p2pFileInput" accept="image/*" multiple hidden />
          </div>

          <div class="prepare-thumbs-grid hidden" id="p2pThumbsList" style="margin-bottom: 1rem;"></div>

          <div style="display: flex; gap: 0.65rem; margin-top: auto;">
            <button type="button" class="btn secondary btn-sm" id="p2pBtnAddMore" style="border-radius: 9999px; padding: 0.45rem 1rem; font-size: 0.82rem;">
              <i data-lucide="plus" style="width: 14px;"></i> Add more
            </button>
            <button type="button" class="btn secondary btn-sm" id="p2pBtnReplace" style="border-radius: 9999px; padding: 0.45rem 1rem; font-size: 0.82rem;">
              <i data-lucide="rotate-cw" style="width: 14px;"></i> Replace
            </button>
            <button type="button" class="btn secondary btn-sm" id="p2pBtnDeleteAll" style="border-radius: 9999px; padding: 0.45rem 1rem; font-size: 0.82rem; color: #ef4444; border-color: rgba(239, 68, 68, 0.35);">
              <i data-lucide="trash-2" style="width: 14px;"></i> Delete all
            </button>
          </div>
        </div>

        <div class="card" style="background: var(--bg-surface, var(--color-panel, #ffffff)); border: 1px solid var(--color-border, transparent); border-radius: 18px; padding: 1.5rem; display: flex; flex-direction: column;">
          ${renderShapeSelector("p2p")}

          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.85rem;">
            <span style="font-weight: 600; font-size: 0.95rem; color: var(--color-text, currentColor);">Background colour</span>
            <button type="button" class="btn secondary btn-sm" id="p2pBgReset" style="font-size: 0.78rem; padding:0.25rem 0.65rem; border-radius: 9999px;">
              <i data-lucide="rotate-ccw" style="width: 12px;"></i> Reset
            </button>
          </div>

          <div style="display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.5rem;">
            ${bgPalette.map(p => `
              <button type="button" class="p2p-color-swatch" data-color="${p.color}" title="${p.label}" style="width: 26px; height: 26px; border-radius: 6px; border: 1.5px solid ${p.color === '#FFFFFF' ? '#3b82f6' : 'rgba(255,255,255,0.2)'}; background: ${p.color === 'transparent' ? 'repeating-conic-gradient(#334155 0% 25%, #1e293b 0% 50%) 50% / 8px 8px' : p.color}; cursor: pointer; transition: transform 0.15s; flex-shrink: 0;"></button>
            `).join("")}
            <span id="p2pHexDisplay" style="font-family: monospace; font-size: 0.78rem; color: #94a3b8; margin-left: 0.35rem;">#FFFFFF</span>
          </div>

          <div style="margin-bottom: 1.25rem;">
            <label style="display: block; font-size: 0.85rem; font-weight: 500; color: var(--color-text, currentColor); margin-bottom: 0.45rem;">
              Style (Optional — auto-pick or type/paste)
            </label>
            <div style="position: relative;">
              <input type="text" id="p2pStyleInput" placeholder="e.g. Vintage Japanese Woodblock, Retro 70s, Cyberpunk..." style="width: 100%; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 0.65rem 2.25rem 0.65rem 0.85rem; font-size: 0.85rem; background: var(--color-surface, var(--bg-surface)); color: var(--color-text);" />
              <button type="button" id="p2pStyleClear" style="position: absolute; right: 8px; top: 50%; transform:translateY(-50%); background: none; border: none; color: #64748b; cursor: pointer; padding: 4px; display: none;">✕</button>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; align-items: center; gap: 0.75rem; margin-top: auto;">
            <label for="p2pVarCount" style="font-size: 0.85rem; color: #94a3b8;">Variations per design</label>
            <input type="number" id="p2pVarCount" min="1" max="10" value="1" style="width: 60px; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; color: #fff; padding: 0.35rem 0.5rem; text-align: center; font-size: 0.85rem;" />
          </div>
        </div>
      </div>

      <div class="card" style="background: var(--bg-surface, var(--color-panel, #ffffff)); border: 1px solid var(--color-border, transparent); border-radius: 16px; padding: 1.15rem 1.5rem; display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
        <div id="p2pStatusSummary" style="font-size: 0.88rem; color: #94a3b8; font-weight: 500;">
          0 designs in, 0 clean versions out
        </div>
        <div style="display: flex; align-items: center; gap: 0.85rem;">
          <button class="btn primary" id="p2pGenerateBtn" style="border-radius: 9999px; padding: 0.65rem 1.85rem; font-size: 0.9rem; font-weight: 600; display: inline-flex; align-items: center; gap: 0.5rem; background: #2563eb;" disabled>
            <i data-lucide="sparkles" style="width: 16px;"></i>
            <span>Generate</span>
          </button>
          <button class="btn secondary" id="p2pStopBtn" style="border-radius: 9999px; padding: 0.65rem 1.25rem; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem;" disabled>
            <i data-lucide="square" style="width: 14px;"></i>
            <span>Stop</span>
          </button>
        </div>
      </div>

      <div class="progress-area hidden" id="p2pProgress" style="margin-bottom: 1.5rem;">
        <p class="progress-line"><i data-lucide="refresh-cw"></i> <span>Starting…</span></p>
        <p class="progress-account hidden" id="p2pAccountLine"></p>
        <div class="progress-bar"><span class="progress-fill" id="p2pProgressFill" style="width:0%"></span></div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; color: #94a3b8; margin-bottom: 1.25rem;">
        <div>Saved to your library. <a href="#" id="p2pOpenLibLink" style="color: #3b82f6; text-decoration: none;">Open library</a></div>
        <div><span id="p2pRedrawnCounter">0</span> redrawn</div>
      </div>

      <div style="background: rgba(245, 158, 11, 0.05); border: 1px solid rgba(245, 158, 11, 0.25); border-radius:12px; padding: 0.85rem 1.15rem; display: flex; align-items: center; gap: 0.65rem; color: #fbbf24; font-size: 0.82rem;">
        <i data-lucide="alert-triangle" style="width: 16px; flex-shrink: 0;"></i>
        <span><strong>Caution — IP risk.</strong> This feature redraws existing designs into derivatives. Review each output for IP risk before uploading or listing it.</span>
      </div>

      <div class="results-grid" id="p2pResultsGrid" style="margin-top: 1.5rem;"></div>
    </div>`;

  renderIcons();

  const dropZone = $("#p2pDropZone");
  const fileInput = $("#p2pFileInput");
  const thumbsList = $("#p2pThumbsList");
  const counterBadge = $("#p2pCounterBadge");
  const statusSummary = $("#p2pStatusSummary");
  const generateBtn = $("#p2pGenerateBtn");
  const stopBtn = $("#p2pStopBtn");
  const hexDisplay = $("#p2pHexDisplay");
  const styleInput = $("#p2pStyleInput");
  const styleClear = $("#p2pStyleClear");
  const varCountInput = $("#p2pVarCount");
  const redrawnCounter = $("#p2pRedrawnCounter");
  const resultsGrid = $("#p2pResultsGrid");
  const progressArea = $("#p2pProgress");
  const progressFill = $("#p2pProgressFill");
  const accountLine = $("#p2pAccountLine");
  const getP2pShape = bindShapeSelector("p2p");

  function syncSummary() {
    const count = sourceFiles.length;
    const vCount = parseInt(varCountInput.value, 10) || 1;
    counterBadge.textContent = count + " / 100";
    statusSummary.textContent = count + " designs in, " + (count * vCount) + " clean versions out";
    generateBtn.disabled = count === 0 || !!abortController;
  }

  async function refreshAccountLine() {
    try {
      const data = await api("/api/accounts");
      const busy = (data.accounts || []).filter((a) => a.status === "generating");
      if (busy.length === 0) {
        accountLine.textContent = "";
        accountLine.classList.add("hidden");
        return;
      }
      const names = busy.map((a) => (a.email || "").trim() || "Google account");
      accountLine.textContent = names.length === 1
        ? `Generating on ${names[0]}`
        : `Generating on ${names[0]} +${names.length - 1} more`;
      accountLine.classList.remove("hidden");
    } catch {
      accountLine.classList.add("hidden");
    }
  }

  function startAccountPoll() {
    refreshAccountLine();
    accountPoll = setInterval(refreshAccountLine, 2500);
  }

  function stopAccountPoll() {
    if (accountPoll) {
      clearInterval(accountPoll);
      accountPoll = null;
    }
    accountLine.textContent = "";
    accountLine.classList.add("hidden");
  }

  function renderThumbs() {
    if (sourceFiles.length === 0) {
      thumbsList.classList.add("hidden");
      thumbsList.innerHTML = "";
    } else {
      thumbsList.classList.remove("hidden");
      thumbsList.innerHTML = sourceFiles.map((file, idx) => `
        <div class="prepare-thumb-item">
          <img src="${URL.createObjectURL(file)}" alt="source-${idx}" />
          <button type="button" class="prepare-thumb-del" data-del="${idx}" title="Remove">✕</button>
        </div>
      `).join("");
    }
    syncSummary();
  }

  function addFiles(files) {
    if (!files || !files.length) return;
    sourceFiles = [...sourceFiles, ...Array.from(files)].slice(0, 100);
    renderThumbs();
  }

  bindDropAndPasteZone({
    dropzoneEl: dropZone,
    inputEl: fileInput,
    onFileReceived: addFiles,
  });

  $("#p2pBtnAddMore").addEventListener("click", () => fileInput.click());
  $("#p2pBtnReplace").addEventListener("click", () => {
    sourceFiles = [];
    fileInput.value = "";
    fileInput.click();
  });
  $("#p2pBtnDeleteAll").addEventListener("click", () => {
    sourceFiles = [];
    fileInput.value = "";
    renderThumbs();
  });

  thumbsList.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (!del) return;
    sourceFiles.splice(parseInt(del.dataset.del, 10), 1);
    renderThumbs();
  });

  document.querySelectorAll(".p2p-color-swatch").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".p2p-color-swatch").forEach(b => {
        b.style.transform = "none";
        b.style.borderColor = "rgba(255,255,255,0.2)";
      });
      btn.style.transform = "scale(1.15)";
      btn.style.borderColor = "#3b82f6";
      selectedBg = btn.dataset.color;
      hexDisplay.textContent = selectedBg.toUpperCase();
    });
  });

  $("#p2pBgReset").addEventListener("click", () => {
    selectedBg = "#FFFFFF";
    hexDisplay.textContent = "#FFFFFF";
    document.querySelectorAll(".p2p-color-swatch").forEach(b => {
      b.style.transform = b.dataset.color === "#FFFFFF" ? "scale(1.15)" : "none";
      b.style.borderColor = b.dataset.color === "#FFFFFF" ? "#3b82f6" : "rgba(255,255,255,0.2)";
    });
  });

  styleInput.addEventListener("input", () => {
    styleClear.style.display = styleInput.value ? "block" : "none";
  });
  styleClear.addEventListener("click", () => {
    styleInput.value = "";
    styleClear.style.display = "none";
  });

  varCountInput.addEventListener("input", syncSummary);

  generateBtn.addEventListener("click", async () => {
    if (sourceFiles.length === 0) return alert("Upload at least one design to redraw.");
    const vCount = parseInt(varCountInput.value, 10) || 1;
    const manualStyle = styleInput.value.trim();

    abortController = new AbortController();
    generateBtn.disabled = true;
    stopBtn.disabled = false;
    progressArea.classList.remove("hidden");
    const labelEl = progressArea.querySelector("span");
    // Continuous progress engine — one simulated curve per in-flight design.
    tracker = new GenerationProgressTracker({
      barEl: progressFill,
      labelEl,
      totalItems: sourceFiles.length,
    });
    tracker.stop();
    labelEl.textContent = "Starting parallel fleet redraw…";
    startAccountPoll();

    resultsGrid.innerHTML = "";
    generatedResults = [];
    redrawnCounter.textContent = "0";
    // Instant skeleton placeholders — one per expected output.
    const totalTasks = sourceFiles.length * vCount;
    activeTotalSlots = totalTasks;
    renderPlaceholders(resultsGrid, totalTasks, "p2p-slot");

    try {
      let completedCount = 0;
      let nextIdx = 0;
      const concurrency = Math.min(5, sourceFiles.length);

      async function worker() {
        while (nextIdx < sourceFiles.length) {
          if (abortController.signal.aborted) break;
          const loopIdx = nextIdx++;
          const file = sourceFiles[loopIdx];
          tracker.startItem(loopIdx);

          const fd = new FormData();
          fd.append("source", file);
          fd.append("count", vCount);
          fd.append("bg_color", selectedBg);
          fd.append("aspectRatio", getP2pShape());
          if (manualStyle) fd.append("manualStyle", manualStyle);

          try {
            // Stream each finished design back as it completes on the fleet.
            await fetchStreamNDJSON(
              "/api/generate/pixel-to-pixel",
              { method: "POST", body: fd, signal: abortController.signal },
              (payload) => {
                if (payload.event === "design" && payload.design) {
                  const globalSlot = loopIdx * vCount + (payload.slotIndex || 0);
                  resolvePlaceholder(`p2p-slot-${globalSlot}`, payload.design);
                  generatedResults.push(payload.design);
                  redrawnCounter.textContent = generatedResults.length;
                } else if (payload.event === "slot_failed") {
                  const globalSlot = loopIdx * vCount + (payload.slotIndex || 0);
                  failPlaceholder(`p2p-slot-${globalSlot}`, payload.error || "Generation failed");
                } else if (payload.event === "error") {
                  console.warn(`Design ${loopIdx + 1} failed:`, payload.error);
                  for (let s = 0; s < vCount; s++) {
                    failPlaceholder(`p2p-slot-${loopIdx * vCount + s}`, payload.error || "Failed");
                  }
                }
              }
            );
          } catch (err) {
            console.error(`Design ${loopIdx + 1} error:`, err);
            for (let s = 0; s < vCount; s++) {
              failPlaceholder(`p2p-slot-${loopIdx * vCount + s}`, err.name === "AbortError" ? "Cancelled" : (err.message || "Failed"));
            }
          } finally {
            completedCount++;
            tracker.finishItem(loopIdx);
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      tracker.completeAll();
    } catch (err) {
      if (err.name !== "AbortError") {
        alert("Redraw process encountered an issue: " + err.message);
      }
    } finally {
      generateBtn.disabled = false;
      stopBtn.disabled = true;
      progressArea.classList.add("hidden");
      stopAccountPoll();
      abortController = null;
      syncSummary();
      refreshAccountsData();
    }
  });

  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;

    // 1. Instantly abort local fetch stream
    if (abortController) {
      try { abortController.abort(); } catch (_) { }
    }

    // 2. Instantly cancel all placeholders currently present in the DOM
    cancelAllPlaceholders(resultsGrid, "Cancelled");

    // 3. Instantly stop progress animation & restore generate button
    if (tracker && typeof tracker.stop === "function") {
      tracker.stop();
    }
    generateBtn.disabled = false;

    const progressLabel = progressArea.querySelector("span");
    if (progressLabel) {
      progressLabel.textContent = "Generation stopped";
    }

    // 4. Fire-and-forget backend cancel beacon (DO NOT await before UI update)
    fetch("/api/generate/cancel", { method: "POST" })
      .catch((err) => console.warn("Cancel signal delivery failed:", err))
      .finally(() => {
        if (typeof startAccountPoll === "function") {
          startAccountPoll();
        }
      });
  });

  $("#p2pOpenLibLink").addEventListener("click", (e) => {
    e.preventDefault();
    if (typeof showView === "function") showView("designs");
  });
}
function renderPrepareDesigns() {
  let sourceFiles = [];
  let selectedPlacement = "top";
  let removeBgType = "without-ai";
  let upscaleFactor = "2x";
  let preparedResults = [];

  viewMount("prepare").innerHTML = `
    <div class="view" style="max-width: 1120px; margin: 0 auto;">
      <header class="view-header" style="margin-bottom: 1.5rem;">
        <div>
          <h1 class="page-title" style="display: flex; align-items: center; gap: 0.6rem; font-size: 1.4rem;">
            <i data-lucide="crop" style="color: #3b82f6;"></i> Prepare Designs
          </h1>
          <p class="view-sub" style="margin-top: 0.2rem; font-size: 0.85rem;">Tick what should happen, then press the button once.</p>
        </div>
      </header>

      <div class="prepare-master-container">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
          <span class="prepare-section-title">Your designs</span>
          <div style="display: flex; align-items: center; gap: 1rem;">
            <span class="prepare-meta-hint">Any image with or without a background <span id="prepFileCountBadge"></span></span>
            <button type="button" class="btn secondary btn-sm" id="prepClearAll" style="padding: 0.35rem 0.75rem; font-size: 0.78rem;">
              <i data-lucide="trash-2" style="width: 13px;"></i> Clear all
            </button>
          </div>
        </div>

        <div class="prepare-drop-area" id="prepDrop">
          <i data-lucide="upload-cloud" style="width: 32px; height: 32px; opacity: 0.6; margin-bottom: 0.3rem;"></i>
          <p style="margin: 0.25rem 0; font-size: 0.9rem; font-weight: 500;">Drop designs here or click to browse</p>
          <p class="prepare-meta-hint" style="margin: 0;">Multiple files accepted — up to 100 · or press <kbd>Ctrl</kbd> + <kbd>V</kbd> to paste</p>
          <input type="file" id="prepFileInput" accept="image/*" multiple hidden />
        </div>

        <div class="prepare-thumbs-grid hidden" id="prepThumbs"></div>

        <div style="text-align: center; margin-top: 0.75rem; display: flex; justify-content: center; gap: 0.6rem;">
          <button type="button" class="btn secondary btn-sm" id="prepAddMore" style="border-radius: 9999px; font-size: 0.8rem; padding: 0.4rem 1.15rem;">
            <i data-lucide="plus" style="width: 14px;"></i> Add more
          </button>
          <button type="button" class="btn secondary btn-sm" id="prepFromLibrary" style="border-radius: 9999px; font-size: 0.8rem; padding: 0.4rem 1.15rem;">
            <i data-lucide="library" style="width: 14px;"></i> From My Designs
          </button>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2rem; margin-bottom: 0.5rem;">
          <span class="prepare-section-title">What should happen to them</span>
          <span class="prepare-meta-hint">Always in this order</span>
        </div>

        <div class="prepare-cards-row">
          <div class="prepare-config-card" id="cardBg">
            <div class="prepare-card-header">
              <input type="checkbox" id="prepOptBg" />
              <label for="prepOptBg" style="cursor: pointer; display: flex; align-items: center; gap: 0.4rem;">
                <i data-lucide="eraser" style="width: 15px;"></i> Remove the background
              </label>
            </div>
            <div class="prepare-pill-group">
              <button type="button" class="prepare-pill-btn active" data-bgopt="without-ai">Without AI</button>
              <button type="button" class="prepare-pill-btn" data-bgopt="with-ai">With AI</button>
            </div>
            <p class="prepare-meta-hint" style="margin-top: 0.75rem; font-size: 0.74rem; line-height: 1.4; flex-grow: 1;">
              Reads the background colour from the corner of the design and trims it out cleanly for pure transparency.
            </p>
            <p style="color: #ef4444; font-size: 0.75rem; font-weight: 600; margin-top: auto; padding-top: 0.75rem; margin-bottom: 0;">Service not available yet</p>
          </div>

          <div class="prepare-config-card" id="cardUpscale" style="display: flex; flex-direction: column;">
            <div class="prepare-card-header">
              <input type="checkbox" id="prepOptUpscale" />
              <label for="prepOptUpscale" style="cursor: pointer; display: flex; align-items: center; gap: 0.4rem;">
                <i data-lucide="maximize" style="width: 15px;"></i> Upscale
              </label>
            </div>
            <div class="prepare-pill-group">
              <button type="button" class="prepare-pill-btn active" data-scale="2x">2×</button>
              <button type="button" class="prepare-pill-btn" data-scale="4x">4×</button>
              <button type="button" class="prepare-pill-btn" data-scale="8x">8×</button>
            </div>
            <p class="prepare-meta-hint" style="margin-top: 0.75rem; font-size: 0.74rem;">
              2048×2048 → 4096×4096 px resolution enhancement.
            </p>
            <p style="color: #ef4444; font-size: 0.75rem; font-weight: 600; margin-top: auto; padding-top: 0.75rem; margin-bottom: 0;">Service not available yet</p>
          </div>

          <div class="prepare-config-card active-card" id="cardResize">
            <div class="prepare-card-header">
              <input type="checkbox" id="prepOptResize" checked />
              <label for="prepOptResize" style="cursor: pointer; display: flex; align-items: center; gap: 0.4rem;">
                <i data-lucide="printer" style="width: 15px;"></i> Resize for printing
              </label>
            </div>
            <div class="prepare-input-row">
              <div class="prepare-field-box">
                <label>Width</label>
                <input type="number" id="prepWidth" value="4500" />
              </div>
              <span class="prepare-times-separator">×</span>
              <div class="prepare-field-box">
                <label>Height</label>
                <input type="number" id="prepHeight" value="5400" />
              </div>
              <div class="prepare-field-box">
                <label>DPI</label>
                <input type="number" id="prepDpi" value="300" />
              </div>
            </div>
            <div style="display: flex; gap: 0.5rem; margin-top: 0.55rem;">
              <button type="button" class="placement-box-btn" data-placement="centred">
                <span class="canvas-frame-icon center"></span>
                <span>Centred</span>
              </button>
              <button type="button" class="placement-box-btn active" data-placement="top">
                <span class="canvas-frame-icon top"></span>
                <span>Top</span>
              </button>
            </div>
          </div>

          <div class="prepare-config-card active-card" id="cardCompress" style="display: flex; flex-direction: column;">
            <div class="prepare-card-header">
              <input type="checkbox" id="prepare-task-compress" checked />
              <label for="prepare-task-compress" style="cursor: pointer; display: flex; align-items: center; gap: 0.4rem;">
                <i data-lucide="archive" style="width: 15px;"></i> Compress
              </label>
            </div>
            <p class="prepare-meta-hint" style="margin-top: 0.75rem; font-size: 0.74rem; line-height: 1.4; flex-grow: 1;">
              Usually 40 to 80% smaller. Each design shows how much came off.
            </p>
            <p style="color: #10b981; font-size: 0.75rem; font-weight: 600; margin-top: auto; padding-top: 0.75rem; margin-bottom: 0;">Preserves 300 DPI & Alpha</p>
          </div>
        </div>

        <div class="prepare-action-bar">
          <div class="prepare-action-summary" id="prepSummary">
            0 designs · resized to 4500 × 5400 px (top)
          </div>
          <button class="prepare-submit-pill" id="prepExecuteBtn" disabled>
            <i data-lucide="play" style="width: 15px; fill: currentColor;"></i>
            <span id="prepExecuteBtnText">Prepare 0 designs</span>
          </button>
        </div>

        <div class="prepare-progress-wrap hidden" id="prepProgressBox" style="margin-top: 1.25rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; font-size: 0.8rem;">
            <span id="prepProgressText" style="color: var(--color-text-muted, #94a3b8);">Preparing designs...</span>
            <span id="prepProgressPercent" style="font-weight: 600; color: #3b82f6;">0%</span>
          </div>
          <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.08); border-radius: 9999px; overflow: hidden;">
            <div id="prepProgressFill" style="width: 0%; height: 100%; background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 9999px; transition: width 0.3s ease;"></div>
          </div>
        </div>
      </div>

      <div class="results-header" style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 2rem; margin-bottom: 1.25rem;">
        <div>
          <span class="prepare-section-title" style="font-size: 0.95rem;">Saved to your designs.</span>
          <span class="prepare-meta-hint" style="display: block; margin-top: 0.2rem;">Use the download button on any result to put a copy where you want it.</span>
        </div>
        <div style="display: flex; align-items: center; gap: 0.65rem;">
          <button type="button" class="btn secondary btn-sm hidden" id="prepDownloadAll" style="border-radius: 9999px; padding: 0.45rem 1rem;">
            <i data-lucide="download" style="width: 14px;"></i> Download all (<span id="prepOutCount">0</span>)
          </button>
          <button type="button" class="btn secondary btn-sm hidden" id="prepClearResults" style="border-radius: 9999px; padding: 0.45rem 1rem; color: #ef4444; border-color: rgba(239, 68, 68, 0.35);">
            <i data-lucide="trash-2" style="width: 14px;"></i> Clear all
          </button>
        </div>
      </div>
      <div class="results-grid" id="prepResults"></div>
    </div>`;

  renderIcons();

  const dropzone = $("#prepDrop");
  const fileInput = $("#prepFileInput");
  const thumbsRow = $("#prepThumbs");
  const summary = $("#prepSummary");
  const executeBtn = $("#prepExecuteBtn");
  const executeBtnText = $("#prepExecuteBtnText");
  const downloadAllBtn = $("#prepDownloadAll");
  const clearResultsBtn = $("#prepClearResults");
  const resultsGrid = $("#prepResults");
  const progressBox = $("#prepProgressBox");
  const progressFill = $("#prepProgressFill");
  const progressText = $("#prepProgressText");
  const progressPercent = $("#prepProgressPercent");

  const cardBg = $("#cardBg");
  const cardUpscale = $("#cardUpscale");
  const cardResize = $("#cardResize");
  const cardCompress = $("#cardCompress");
  const chkBg = $("#prepOptBg");
  const chkUpscale = $("#prepOptUpscale");
  const chkResize = $("#prepOptResize");
  const chkCompress = $("#prepare-task-compress");

  function syncCardStates() {
    cardBg?.classList.toggle("active-card", chkBg?.checked);
    cardUpscale?.classList.toggle("active-card", chkUpscale?.checked);
    cardResize?.classList.toggle("active-card", chkResize?.checked);
    cardCompress?.classList.toggle("active-card", chkCompress?.checked);
  }

  chkBg?.addEventListener("change", () => { syncCardStates(); updateSummary(); });
  chkUpscale?.addEventListener("change", () => { syncCardStates(); updateSummary(); });
  chkResize?.addEventListener("change", () => { syncCardStates(); updateSummary(); });
  chkCompress?.addEventListener("change", () => { syncCardStates(); updateSummary(); });

  function updateSummary() {
    const count = sourceFiles.length;
    const w = ($("#prepWidth") && $("#prepWidth").value) ? $("#prepWidth").value : "4500";
    const h = ($("#prepHeight") && $("#prepHeight").value) ? $("#prepHeight").value : "5400";
    let parts = [count + (count === 1 ? " design" : " designs")];
    if (chkBg?.checked) parts.push("background off with " + (removeBgType === "with-ai" ? "AI" : "classic"));
    if (chkUpscale?.checked) parts.push("upscaled " + upscaleFactor);
    if (chkResize?.checked) parts.push("resized to " + w + " × " + h + " px (" + selectedPlacement + ")");
    if (chkCompress?.checked) parts.push("compressed");

    summary.textContent = parts.join(" · ");
    executeBtnText.textContent = "Prepare " + count + (count === 1 ? " design" : " designs");
    executeBtn.disabled = count === 0;
    const badge = $("#prepFileCountBadge");
    if (badge) badge.textContent = count > 0 ? ("(" + count + ")") : "";
  }

  function renderThumbs() {
    if (sourceFiles.length === 0) {
      thumbsRow.classList.add("hidden");
      thumbsRow.innerHTML = "";
    } else {
      thumbsRow.classList.remove("hidden");
      thumbsRow.innerHTML = sourceFiles.map((file, idx) => `
        <div class="prepare-thumb-item" data-idx="${idx}">
          <img src="${URL.createObjectURL(file)}" alt="thumb" />
          <button type="button" class="prepare-thumb-del" data-del="${idx}" title="Remove">✕</button>
        </div>
      `).join("");
    }
    updateSummary();
  }

  function addFiles(files) {
    sourceFiles = [...sourceFiles, ...Array.from(files)].slice(0, 100);
    renderThumbs();
  }

  bindDropAndPasteZone({
    dropzoneEl: dropzone,
    inputEl: fileInput,
    onFileReceived: addFiles,
  });

  $("#prepAddMore").addEventListener("click", () => fileInput.click());

  // ── "From My Designs" — library import picker ──────────────
  // Opens the shared library picker modal (GET /api/designs), lets the user
  // multi-select up to the remaining slot capacity (100 total), then fetches
  // each chosen output image as a Blob → File and appends it to sourceFiles.
  // Native uploads (browse, drag-drop, paste) are untouched.
  $("#prepFromLibrary").addEventListener("click", () => {
    openLibraryPicker({
      currentCount: sourceFiles.length,
      onConfirm: (files) => addFiles(files),
    });
  });
  $("#prepClearAll").addEventListener("click", () => {
    sourceFiles = [];
    fileInput.value = "";
    renderThumbs();
  });

  thumbsRow.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (!del) return;
    sourceFiles.splice(parseInt(del.dataset.del, 10), 1);
    renderThumbs();
  });

  document.querySelectorAll("[data-placement]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-placement]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedPlacement = btn.dataset.placement;
      updateSummary();
    });
  });

  document.querySelectorAll("[data-bgopt]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-bgopt]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      removeBgType = btn.dataset.bgopt;
      updateSummary();
    });
  });

  document.querySelectorAll("[data-scale]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-scale]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      upscaleFactor = btn.dataset.scale;
      updateSummary();
    });
  });

  clearResultsBtn.addEventListener("click", () => {
    preparedResults = [];
    resultsGrid.innerHTML = "";
    downloadAllBtn.classList.add("hidden");
    clearResultsBtn.classList.add("hidden");
    $("#prepOutCount").textContent = "0";
  });

  executeBtn.addEventListener("click", async () => {
    if (sourceFiles.length === 0) return;

    executeBtn.disabled = true;
    progressBox.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressPercent.textContent = "0%";
    progressText.textContent = "Preparing 0 of " + sourceFiles.length + " designs...";
    resultsGrid.innerHTML = "";
    preparedResults = [];
    downloadAllBtn.classList.add("hidden");
    clearResultsBtn.classList.add("hidden");

    let currentPct = 10;
    progressFill.style.width = currentPct + "%";
    progressPercent.textContent = currentPct + "%";

    const progressTimer = setInterval(() => {
      if (currentPct < 90) {
        currentPct += 10;
        progressFill.style.width = currentPct + "%";
        progressPercent.textContent = currentPct + "%";
        progressText.textContent = "Compositing safe print area (" + currentPct + "%)...";
      }
    }, 250);

    const fd = new FormData();
    sourceFiles.forEach(f => fd.append("sources", f));
    fd.append("placement", selectedPlacement);
    fd.append("width", ($("#prepWidth") && $("#prepWidth").value) ? $("#prepWidth").value : 4500);
    fd.append("height", ($("#prepHeight") && $("#prepHeight").value) ? $("#prepHeight").value : 5400);
    fd.append("dpi", ($("#prepDpi") && $("#prepDpi").value) ? $("#prepDpi").value : 300);
    fd.append("resize", chkResize ? (chkResize.checked ? "true" : "false") : "true");
    fd.append("compress", chkCompress ? (chkCompress.checked ? "true" : "false") : "true");

    try {
      const res = await fetch("/api/prepare-designs", {
        method: "POST",
        body: fd
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preparation failed");

      clearInterval(progressTimer);

      progressFill.style.width = "100%";
      progressPercent.textContent = "100%";
      progressText.textContent = "Done! " + data.designs.length + " designs ready for print.";

      const batch = data.designs || [];
      preparedResults.push(...batch);

      batch.forEach(d => {
        resultsGrid.insertAdjacentHTML("beforeend", resultCard(d));
      });
      renderIcons();

      downloadAllBtn.classList.remove("hidden");
      clearResultsBtn.classList.remove("hidden");
      $("#prepOutCount").textContent = preparedResults.length;
    } catch (err) {
      clearInterval(progressTimer);
      console.error(err);
      alert("Error: " + err.message);
      progressBox.classList.add("hidden");
    } finally {
      executeBtn.disabled = false;
      setTimeout(() => progressBox.classList.add("hidden"), 3000);
    }
  });

  downloadAllBtn.addEventListener("click", () => {
    preparedResults.forEach((d, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = d.output_image_path || d.path;
        a.download = "prepared-print-4500x5400-" + (i + 1) + ".png";
        a.click();
      }, i * 200);
    });
  });
}


let currentView = "home";
window.currentView = currentView;

function showView(name) {
  lastHoveredDropzone = null;
  lastActiveDropzone = null;
  document.querySelectorAll(".dropzone-active-target").forEach((el) => el.classList.remove("dropzone-active-target"));
  document.querySelectorAll(".side-active-target").forEach((el) => el.classList.remove("side-active-target"));
  if (!views[name]) name = "home";
  currentView = name;
  window.currentView = name;

  if (viewTeardown) {
    viewTeardown();
    viewTeardown = null;
  }
  $$(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name)
  );

  // Toggle Phantom Arc Aura background host:
  // EXCLUDE HOME PAGE: hidden when active view is home, visible across all inner sections
  const auraHost = document.getElementById("auraBgHost");
  if (auraHost) {
    auraHost.classList.toggle("hidden", currentView === "home");
  }

  // Hide every mounted section, then reveal the target — pure CSS toggle,
  // no innerHTML wiping, no DOM destruction.
  document.querySelectorAll("#view > .app-section").forEach((el) => el.classList.add("hidden"));

  // Locate or create the section container.
  let target = document.getElementById(`section-${name}`);
  if (!target) {
    target = document.createElement("div");
    target.id = `section-${name}`;
    target.className = name === "home" ? "app-section" : "app-section aura-content view-section";
    $("#view").appendChild(target);
  }
  if (name !== "home") {
    target.classList.add("aura-content", "view-section");
  } else {
    target.classList.remove("aura-content", "view-section");
  }

  // If the section has never been populated, execute its render function.
  // (Checks innerHTML rather than a bookkeeping set so an empty container
  // always gets rendered, even if a previous mount attempt failed.)
  if (!target.innerHTML.trim()) {
    mountedViews.add(name);
    const result = views[name]();
    if (result && typeof result.then === "function") {
      result.then(() => renderIcons()).catch(() => { });
    }
  }

  // Reveal the target section.
  target.classList.remove("hidden");
  renderIcons();
  // The home typewriter is stopped by its teardown on navigation; since the
  // section persists (no re-render), restart it when home becomes visible.
  if (name === "home" && document.getElementById("heroTypewriter")) {
    startTypewriter();
  }
  // Always refresh accounts when navigating to it (or if marked dirty after a generation)
  if (name === "accounts") {
    accountsDirty = false;
    renderAccounts();
  }
  // Always refresh the library when navigating to it — fetches the latest
  // designs from the backend so newly generated work appears without F5.
  if (name === "designs") {
    renderDesigns();
  }
}

/* ── Home Landing View ───────────────────────────────────── */

function renderHome() {
  viewMount("home").innerHTML = `
    <div class="view home-view">
      <video class="home-bg-video" autoplay loop muted playsinline src="/hero-bg.mp4" aria-hidden="true"></video>
      <div class="home-scrim" aria-hidden="true"></div>

      <!-- Centered Hero Stage -->
      <div class="home-hero-stage">
        <div class="hero-content">
          <h1 class="hero-title luxury-enter">
            <span class="hero-title-main">Architect Your Print-on-Demand</span>
            <div class="hero-title-dynamic">
              <span id="heroTypewriter" class="gradient-text">Ecosystem</span><span class="type-cursor" aria-hidden="true">|</span>
            </div>
          </h1>
          <p class="hero-sub luxury-enter">Multi-threaded Gemini vision engine. Scale localized niches, redraw production-ready vectors, and dominate marketplaces at zero rate-limit delay.</p>
          <div class="hero-cta luxury-enter">
            <button class="btn primary" id="heroStart"><i data-lucide="sparkles"></i> Launch Engine</button>
            <button class="btn secondary" id="heroAccounts"><i data-lucide="users"></i> Manage Nodes</button>
          </div>
        </div>

        <div class="stats-pill luxury-enter">
          Multi Active Gemini Slots · Multi-Threaded Automation · Zero Rate-Limit Delay
        </div>
      </div>

      <!-- Bottom Card Deck with Right-Side Control -->
      <div class="home-deck-outer">
        <div class="home-deck-viewport">
          <div class="home-deck-track" id="homeCardsTrack">
            <!-- Page 1: Primary Tools -->
            <div class="home-deck-page" id="homeCardsPage1">
              <div class="home-pillar-card luxury-enter" data-go="variations">
                <div class="pillar-icon"><i data-lucide="sliders"></i></div>
                <div class="pillar-title">Niche Variations</div>
                <div class="pillar-desc">1 base design in, up to 100 localized niche variations out.</div>
              </div>
              <div class="home-pillar-card luxury-enter" data-go="d2d">
                <div class="pillar-icon"><i data-lucide="layers"></i></div>
                <div class="pillar-title">Design to Design</div>
                <div class="pillar-desc">Batch redraw up to 100 designs into fresh print-ready artwork.</div>
              </div>
              <div class="home-pillar-card luxury-enter" data-go="t2i">
                <div class="pillar-icon"><i data-lucide="type"></i></div>
                <div class="pillar-title">Text to Image</div>
                <div class="pillar-desc">Prompt-driven generation with multi-variation batches.</div>
              </div>
              <div class="home-pillar-card luxury-enter" data-go="accounts">
                <div class="pillar-icon"><i data-lucide="users"></i></div>
                <div class="pillar-title">Gemini Accounts</div>
                <div class="pillar-desc">Monitor session health, usage limits, and active browser profiles.</div>
              </div>
            </div>

            <!-- Page 2: Secondary Tools -->
            <div class="home-deck-page" id="homeCardsPage2">
              <div class="home-pillar-card" data-go="pixel-to-pixel">
                <div class="pillar-icon"><i data-lucide="sparkles"></i></div>
                <div class="pillar-title">Pixel to Pixel</div>
                <div class="pillar-desc">Multi-canvas redesign with strict composition preservation.</div>
              </div>
              <div class="home-pillar-card" data-go="prepare">
                <div class="pillar-icon"><i data-lucide="crop"></i></div>
                <div class="pillar-title">Prepare Designs</div>
                <div class="pillar-desc">Trim backgrounds, upscale, and format print-ready files.</div>
              </div>
              <div class="home-pillar-card" data-go="magicListing">
                <div class="pillar-icon"><i data-lucide="tag"></i></div>
                <div class="pillar-title">Magic Listing</div>
                <div class="pillar-desc">Vision-powered listings for Amazon Merch and TeePublic.</div>
              </div>
              <div class="home-pillar-card" data-go="artstyle">
                <div class="pillar-icon"><i data-lucide="palette"></i></div>
                <div class="pillar-title">Art Style + Niche</div>
                <div class="pillar-desc">Explore curated art styles, typography rules, and trending niches.</div>
              </div>
            </div>
          </div>
        </div>

        <button type="button" class="home-deck-side-btn" id="homeDeckSideBtn" aria-label="Show more tools" title="Slide to view more tools">
          <span class="home-deck-side-label">More</span>
          <svg class="home-deck-side-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>
          </svg>
        </button>
      </div>
    </div>`;

  // CTA Click Handlers
  $("#heroStart")?.addEventListener("click", () => showView("variations"));
  $("#heroAccounts")?.addEventListener("click", () => showView("accounts"));

  // Card Navigation Handlers
  $$(".home-pillar-card[data-go]").forEach(card => {
    card.addEventListener("click", () => showView(card.dataset.go));
  });

  // 2-Page Deck Slider (Right Button: More / Back)
  const track = $("#homeCardsTrack");
  const sideBtn = $("#homeDeckSideBtn");
  if (track && sideBtn) {
    const label = sideBtn.querySelector(".home-deck-side-label");
    const arrow = sideBtn.querySelector(".home-deck-side-arrow");
    let isPage2 = false;

    sideBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      isPage2 = !isPage2;
      track.classList.toggle("is-page-2", isPage2);
      if (label) label.textContent = isPage2 ? "Back" : "More";
      if (arrow) {
        arrow.innerHTML = isPage2
          ? '<path d="M19 12H5"></path><path d="m12 19-7-7 7-7"></path>'
          : '<path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>';
      }
      sideBtn.setAttribute("aria-label", isPage2 ? "Back to main tools" : "Show more tools");
      sideBtn.classList.toggle("is-back", isPage2);
    });
  }

  renderIcons();
}

/* File-scoped so a pending tick can always be cancelled — both by the next
   renderHome() and by the view teardown that showView() runs on navigation. */
let typewriterTimeout = null;

/* Hero typewriter — types a word, holds it, backspaces it, pauses, then moves
   to the next, forever. Runs unconditionally: there is deliberately NO
   prefers-reduced-motion gate here (it froze the cycle for users with OS
   animations off, leaving the headline stuck on "Studio").

   Singleton timer management: the active timeout handle lives on
   window._heroTypewriterTimeout so ANY caller (renderHome, showView, or a
   stray duplicate) can cancel the previous loop before starting a new one.
   Only one loop can ever be pending — no concurrent timers fighting over the
   same element, no jitter. */
function startTypewriter() {
  // Cancel any existing loop before (re)starting — this is the anti-jitter
  // guard: returning to Home must never stack a second recursive loop on top
  // of a live one.
  if (window._heroTypewriterTimeout) {
    clearTimeout(window._heroTypewriterTimeout);
    window._heroTypewriterTimeout = null;
  }
  if (typewriterTimeout) {
    clearTimeout(typewriterTimeout);
    typewriterTimeout = null;
  }

  const twEl = document.getElementById("heroTypewriter");
  if (!twEl) return;

  const words = ["Ecosystem", "Empire", "Pipeline", "Infrastructure"];
  const TYPE_MS = 85;        // natural, deliberate typing cadence
  const HOLD_MS = 2200;      // pause once a word completes typing
  const DELETE_MS = 45;      // quick, crisp backspace
  const SWITCH_PAUSE_MS = 350; // pause when a word is fully deleted
  const INITIAL_PAUSE_MS = 2000; // read the first word before deleting

  // The markup already shows words[0] ("Ecosystem") in full, so the loop
  // opens on the tail of that word's hold — charIdx starts at the full length
  // and the first tick backspaces. Starting at 0 would re-type the finished
  // word and make the headline jump on load.
  let wordIdx = 0;
  let charIdx = words[0].length;
  let isDeleting = true;

  function schedule(ms) {
    clearTimeout(window._heroTypewriterTimeout);
    window._heroTypewriterTimeout = setTimeout(tick, ms);
  }

  function tick() {
    // DOM lifecycle safety: re-query the node every tick. If the element is
    // gone or detached (view swapped out), stop rescheduling so the loop
    // terminates cleanly instead of firing into the void.
    const el = document.getElementById("heroTypewriter");
    if (!el || !document.body.contains(el)) {
      window._heroTypewriterTimeout = null;
      return;
    }

    const word = words[wordIdx];

    if (isDeleting) {
      charIdx--;
    } else {
      charIdx++;
    }
    el.textContent = word.slice(0, charIdx);

    if (isDeleting) {
      if (charIdx <= 0) {
        isDeleting = false;
        wordIdx = (wordIdx + 1) % words.length;
        schedule(SWITCH_PAUSE_MS);
      } else {
        schedule(DELETE_MS);
      }
      return;
    }

    if (charIdx >= word.length) {
      isDeleting = true;
      schedule(HOLD_MS);
    } else {
      schedule(TYPE_MS);
    }
  }

  // Opens on the tail of the first word's hold: the completed word stays on
  // screen for INITIAL_PAUSE_MS before the first backspace.
  schedule(INITIAL_PAUSE_MS);

  viewTeardown = () => {
    clearTimeout(window._heroTypewriterTimeout);
    window._heroTypewriterTimeout = null;
    typewriterTimeout = null;
  };
}

/* ── Shared "From My Designs" library picker ────────────────
   One modal (#prepLibraryModal) serves every workspace that imports saved
   designs (Prepare Designs, Magic Listing, …). openLibraryPicker() wires the
   modal's grid, toolbar, and confirm button to the caller's queue:

     openLibraryPicker({
       currentCount,          // how many designs are already queued (0–100)
       onConfirm(files),      // receives File[] to append to the caller's queue
     })

   The modal fetches GET /api/designs, renders square thumbnail tiles with
   multi-select, caps selection at the remaining 100-slot capacity, then on
   confirm fetches each chosen output image as a Blob → File and hands the
   array to onConfirm. Native uploads in the caller are untouched. */
// Active session pointer to cleanly separate callers (Prepare Designs, Magic Listing, etc.)
let activePickerSession = null;

function openLibraryPicker({ currentCount = 0, onConfirm = null } = {}) {
  const modal = $("#prepLibraryModal");
  const grid = $("#prepLibGrid");
  const countEl = $("#prepLibCount");
  const confirmBtn = $("#prepLibConfirm");
  const subEl = $("#prepLibSub");
  if (!modal || !grid || !countEl || !confirmBtn || !subEl) return;

  // Always bind the active caller session cleanly on every open
  activePickerSession = {
    currentCount: Math.max(0, currentCount),
    onConfirm: typeof onConfirm === "function" ? onConfirm : null,
  };

  let rows = [];
  const selected = new Set();

  function getRemaining() {
    return Math.max(0, 100 - (activePickerSession ? activePickerSession.currentCount : 0));
  }

  function render() {
    const remaining = getRemaining();
    grid.innerHTML = rows.map((d) => {
      const disabled = remaining <= 0 && !selected.has(d.id);
      const checked = selected.has(d.id);
      const label = (d.feature || "design").replace(/-/g, " ");
      const cleanTitle = d.user_input && d.user_input !== d.feature ? d.user_input : label;
      return `
        <div class="prep-lib-item ${checked ? "selected" : ""} ${disabled ? "disabled" : ""}" data-id="${esc(d.id)}">
          <img src="/library/${esc(d.output_image_path)}" alt="" loading="lazy" />
          <div class="prep-lib-check"><i data-lucide="check"></i></div>
          <div class="prep-lib-caption" title="${esc(cleanTitle)}">${esc(cleanTitle)}</div>
          <div class="prep-lib-meta">${esc(label)}</div>
        </div>`;
    }).join("");
    renderIcons();
    countEl.textContent = `${selected.size} selected`;
    confirmBtn.disabled = selected.size === 0;
    subEl.textContent = remaining > 0
      ? `Select up to ${remaining} more design${remaining === 1 ? "" : "s"} to add to the queue.`
      : "Queue is full (100/100). Deselect some to add more.";
  }

  function close() {
    modal.classList.add("hidden");
    selected.clear();
    activePickerSession = null;
  }

  // Wire static DOM events once — dynamic data is read from activePickerSession
  if (!modal.dataset.libPickerWired) {
    modal.dataset.libPickerWired = "1";
    $("#prepLibraryClose")?.addEventListener("click", close);
    $("#prepLibCancel")?.addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });

    grid.addEventListener("click", (e) => {
      const item = e.target.closest(".prep-lib-item");
      if (!item || item.classList.contains("disabled")) return;
      const id = item.dataset.id;
      if (selected.has(id)) {
        selected.delete(id);
      } else {
        const remaining = getRemaining();
        if (selected.size >= remaining) return;
        selected.add(id);
      }
      render();
    });

    $("#prepLibSelectAll")?.addEventListener("click", () => {
      const remaining = getRemaining();
      selected.clear();
      rows.slice(0, remaining).forEach((d) => selected.add(d.id));
      render();
    });

    $("#prepLibDeselectAll")?.addEventListener("click", () => {
      selected.clear();
      render();
    });

    confirmBtn.addEventListener("click", async () => {
      const chosen = rows.filter((d) => selected.has(d.id));
      if (!chosen.length) return;

      const sessionCallback = activePickerSession ? activePickerSession.onConfirm : null;
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Loading...";

      try {
        const files = [];
        for (const d of chosen) {
          const res = await fetch(`/library/${d.output_image_path}`);
          if (!res.ok) continue;
          const blob = await res.blob();
          const ext = (String(d.output_image_path).match(/\.(\w{2,5})$/) || [null, "png"])[1].toLowerCase();
          const name = `library-${d.id}.${ext}`;
          files.push(new File([blob], name, { type: blob.type || "image/png" }));
        }

        if (files.length && sessionCallback) {
          sessionCallback(files);
        }
      } catch (err) {
        console.error("Failed to load designs from library:", err);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Add selected";
        close();
      }
    });
  }

  // Load fresh library designs on every modal launch
  api("/api/designs?pageSize=120").then((data) => {
    rows = data.designs || data.rows || [];
    render();
    modal.classList.remove("hidden");
  }).catch((err) => {
    console.error("Failed to fetch designs for picker:", err);
  });
}

function renderTextToImage() {
  let selectedBg = "transparent";
  let abortController = null;
  let magicStyle = null;
  // Hoisted so the Stop handler can mark every pending slot and stop the
  // progress engine without re-reading the DOM.
  let activeCount = 0;
  let tracker = null;

  // t2i's own palette — the same row as Design to Design, plus Crimson.
  const T2I_BG_SWATCHES = [
    { label: "Transparent", value: "transparent", isTransparent: true },
    { label: "White", value: "#FFFFFF", color: "#FFFFFF" },
    { label: "Black", value: "#000000", color: "#000000" },
    { label: "Cream", value: "#F5F0E6", color: "#F5F0E6" },
    { label: "Navy", value: "#1E3A8A", color: "#1E3A8A" },
    { label: "Crimson", value: "#DC2626", color: "#DC2626" },
    { label: "Forest", value: "#14532D", color: "#14532D" },
    { label: "Amber", value: "#D97706", color: "#D97706" },
  ];

  viewMount("t2i").innerHTML = `
    <div class="view">
      <header class="view-header">
        <div>
          <h1 class="page-title">Text to Image</h1>
          <p class="view-sub">Prompt-driven generation — output commercial POD artwork from text descriptions.</p>
        </div>
      </header>

      <div class="t2i-workspace">
        <section class="t2i-panel">
          <label class="field">
            <span class="field-label">Design idea</span>
            <textarea id="t2iPrompt" class="prompt-editor" placeholder="e.g. a cozy winter cabin wrapped in pine, 70s retro diner sign, kawaii strawberry mascot…" required></textarea>
          </label>

          <label class="field">
            <span class="field-label">Variations (1–100)</span>
            <input type="number" id="t2iCount" min="1" max="100" value="3" />
          </label>

          <div class="manual-style-field">
            <label class="manual-style-label" for="t2iManualStyle">Style (Optional — auto-pick or type/paste)</label>
            <div class="style-input-group">
              <input type="text" id="t2iManualStyle" class="manual-style-input" placeholder="e.g. Vintage Japanese Woodblock, Retro 70s, Cyberpunk..." />
              <button type="button" class="clear-style-btn" title="Clear style" data-clear="t2iManualStyle">×</button>
            </div>
          </div>

          <div class="magic-style-container" id="t2iMagicStyle">
            <button type="button" class="magic-style-btn" id="t2iMagicBtn">${MAGIC_STYLE_BTN_DEFAULT}</button>
          </div>

          ${renderShapeSelector("t2i")}

          <div class="stage-head">
            <span class="stage-title">Background color</span>
            <button type="button" class="btn secondary btn-sm" id="t2iResetBg"><i data-lucide="rotate-ccw"></i> Reset</button>
          </div>

          <div class="field">
            <div class="swatch-row" id="t2iSwatches">
              ${T2I_BG_SWATCHES.map((s) => `
                <button type="button" class="swatch ${s.isTransparent ? 'transparent active' : ''}"
                  data-val="${s.value}"
                  title="${s.label}"
                  aria-label="${s.label}"
                  style="${s.color ? `background-color: ${s.color};` : ''}">
                </button>
              `).join("")}
              <div class="swatch-custom" id="t2iCustomSwatch">
                <input type="color" id="t2iColorPicker" value="#ffffff" aria-label="Custom background color" />
                <input type="text" id="t2iColorHex" value="#FFFFFF" spellcheck="false" aria-label="Custom background hex value" />
              </div>
            </div>
          </div>

          <div class="action-row">
            <button class="btn primary" id="t2iGenerate"><i data-lucide="sparkles"></i> Generate</button>
            <button class="btn secondary" id="t2iStop" disabled><i data-lucide="square"></i> Stop</button>
          </div>

          <div class="progress-area hidden" id="t2iProgress">
            <p class="progress-line"><i data-lucide="refresh-cw"></i> <span>Starting…</span></p>
            <div class="progress-bar"><span class="progress-fill" id="t2iProgressFill" style="width:0%"></span></div>
          </div>
        </section>

        <section class="t2i-output-panel">
          <div class="stage-head">
            <span class="stage-title">Output Canvas</span>
            <span class="stage-counter" id="t2iOutCount">0 generated</span>
          </div>
          <p class="results-sub">Saved to your library. <a href="#" class="text-link" id="t2iOpenLibrary">Open library</a></p>

          <div class="t2i-empty-canvas" id="t2iEmpty">
            <i data-lucide="image-plus"></i>
            <p>Generated artwork will appear here</p>
          </div>

          <div class="results-grid hidden" id="t2iResults"></div>
        </section>
      </div>
    </div>`;

  renderIcons();

  const getT2iShape = bindShapeSelector("t2i");
  const generateBtn = $("#t2iGenerate");
  const stopBtn = $("#t2iStop");

  magicStyle = setupMagicStyle({
    btn: $("#t2iMagicBtn"),
    container: $("#t2iMagicStyle"),
    getContext: () => ({ prompt: $("#t2iPrompt").value.trim(), imageFile: null }),
    onStyle: (name) => {
      const input = $("#t2iManualStyle");
      if (input) input.value = name;
    },
  });

  $$("#t2iSwatches .swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#t2iSwatches .swatch").forEach((b) => b.classList.remove("active"));
      $("#t2iCustomSwatch").classList.remove("active");
      btn.classList.add("active");
      selectedBg = btn.dataset.val;
    });
  });

  const t2iColorPicker = $("#t2iColorPicker");
  const t2iColorHex = $("#t2iColorHex");
  const t2iCustomSwatch = $("#t2iCustomSwatch");

  t2iColorPicker.addEventListener("input", (e) => {
    $$("#t2iSwatches .swatch").forEach((b) => b.classList.remove("active"));
    t2iCustomSwatch.classList.add("active");
    t2iColorHex.value = e.target.value.toUpperCase();
    selectedBg = e.target.value;
  });

  t2iColorHex.addEventListener("change", (e) => {
    let val = e.target.value.trim();
    if (!val.startsWith("#")) val = "#" + val;
    t2iColorPicker.value = val;
    t2iColorHex.value = val.toUpperCase();
    $$("#t2iSwatches .swatch").forEach((b) => b.classList.remove("active"));
    t2iCustomSwatch.classList.add("active");
    selectedBg = val;
  });

  // Reset clears back to transparent, which is the view's opening state.
  $("#t2iResetBg").addEventListener("click", () => {
    selectedBg = "transparent";
    $$("#t2iSwatches .swatch").forEach((b) => b.classList.remove("active"));
    t2iCustomSwatch.classList.remove("active");
    $("#t2iSwatches .swatch[data-val='transparent']")?.classList.add("active");
  });

  $("#t2iOpenLibrary").addEventListener("click", (e) => {
    e.preventDefault();
    showView("designs");
  });

  generateBtn.addEventListener("click", async () => {
    const prompt = $("#t2iPrompt").value.trim();
    const count = Math.min(100, Math.max(1, parseInt($("#t2iCount").value, 10) || 1));
    if (!prompt) return alert("Please enter a design description first.");
    activeCount = count;

    abortController = new AbortController();
    generateBtn.disabled = true;
    stopBtn.disabled = false;

    // Canvas & skeleton placeholders — swap the empty illustration for the
    // results grid the instant Generate is clicked, one skeleton per output.
    const grid = $("#t2iResults");
    const emptyState = $("#t2iEmpty");
    const counterEl = $("#t2iOutCount");
    grid.innerHTML = "";
    grid.classList.remove("hidden");
    if (emptyState) emptyState.classList.add("hidden");
    if (counterEl) counterEl.textContent = `0 of ${count} generated`;
    renderPlaceholders(grid, count, "t2i-slot");

    // Progress bar & engine — one simulated curve per output, aggregated.
    const progressArea = $("#t2iProgress");
    progressArea.classList.remove("hidden");
    const fillEl = $("#t2iProgressFill");
    fillEl.style.width = "0%";
    const labelEl = progressArea.querySelector("span");
    labelEl.textContent = "Starting text-to-image generation…";
    tracker = new GenerationProgressTracker({
      barEl: fillEl,
      labelEl,
      totalItems: count,
    });
    for (let i = 0; i < count; i++) {
      tracker.startItem(i);
    }
    if (typeof startAccountPoll === "function") startAccountPoll();

    const fd = new FormData();
    fd.append("prompt", prompt);
    fd.append("count", count);
    fd.append("bg_color", selectedBg);
    fd.append("aspectRatio", getT2iShape());
    fd.append("manualStyle", ($("#t2iManualStyle")?.value || "").trim());
    if (typeof appendMagicStyle === "function" && magicStyle) {
      appendMagicStyle(fd, magicStyle.get());
    }

    let completedSlots = 0;

    try {
      await fetchStreamNDJSON(
        "/api/generate/text-to-image",
        {
          method: "POST",
          body: fd,
          signal: abortController.signal,
        },
        ({ event, slotIndex, design, error }) => {
          if (event === "design" && design) {
            resolvePlaceholder(`t2i-slot-${slotIndex}`, design);
            tracker.completeItem(slotIndex);
            completedSlots++;
            if (counterEl) counterEl.textContent = `${completedSlots} of ${count} generated`;
            renderIcons();
          } else if (event === "error" || event === "slot_failed") {
            failPlaceholder(`t2i-slot-${slotIndex}`, error || "Generation failed");
            tracker.completeItem(slotIndex);
          } else if (event === "done") {
            tracker.completeAll();
          }
        }
      );
      tracker.completeAll();
    } catch (err) {
      if (err.name === "AbortError") {
        for (let i = 0; i < count; i++) {
          failPlaceholder(`t2i-slot-${i}`, "Cancelled");
        }
      } else {
        console.error("Text to image generation failed:", err);
        alert("Generation failed: " + (err.message || "Unknown error"));
        for (let i = 0; i < count; i++) {
          failPlaceholder(`t2i-slot-${i}`, err.message || "Failed");
        }
      }
      tracker.stop();
    } finally {
      generateBtn.disabled = false;
      stopBtn.disabled = true;
      abortController = null;
      if (grid.children.length === 0 && emptyState) {
        grid.classList.add("hidden");
        emptyState.classList.remove("hidden");
      }
      refreshAccountsData();
    }
  });

  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;

    // 1. Instantly abort local fetch stream
    if (abortController) {
      try { abortController.abort(); } catch (_) { }
    }

    // 2. Instantly cancel all placeholders currently present in the DOM
    // (DOM-driven — query whatever cards are physically inside #t2iResults)
    const t2iGrid = $("#t2iResults");
    if (t2iGrid) {
      t2iGrid.querySelectorAll(".card-placeholder").forEach((card) => {
        failPlaceholder(card.id, "Cancelled");
      });
    }

    // 3. Instantly stop progress animation & restore generate button
    if (tracker && typeof tracker.stop === "function") {
      tracker.stop();
    }
    generateBtn.disabled = false;

    const t2iProgress = $("#t2iProgress");
    if (t2iProgress) {
      const span = t2iProgress.querySelector("span");
      if (span) span.textContent = "Generation stopped";
    }

    // 4. Fire-and-forget backend cancel beacon (DO NOT await before UI update)
    fetch("/api/generate/cancel", { method: "POST" })
      .catch((err) => console.warn("Cancel signal delivery failed:", err))
      .finally(() => {
        if (typeof startAccountPoll === "function") {
          startAccountPoll();
        }
      });
  });
}

/* ── Niche Variations View (Multi-Canvas + Color Swatches) ── */

function renderVariations() {
  let baseFiles = [];
  let selectedBg = "transparent";
  let abortController = null;
  let magicStyle = null;
  // Per-design style analyses: analyses[i] corresponds to baseFiles[i].
  let designAnalyses = [];
  let analyzing = false;
  // Hoisted so the Stop handler can mark every pending slot and stop the
  // progress engine without re-reading the DOM.
  let activeTotalSlots = 0;
  let tracker = null;

  const BG_SWATCHES = [
    { label: "Transparent", value: "transparent", isTransparent: true },
    { label: "White", value: "#FFFFFF", color: "#FFFFFF" },
    { label: "Dark grey", value: "#111827", color: "#111827" },
    { label: "Black", value: "#000000", color: "#000000" },
    { label: "Cream", value: "#F5F0E6", color: "#F5F0E6" },
    { label: "Navy", value: "#1E3A8A", color: "#1E3A8A" },
    { label: "Forest", value: "#14532D", color: "#14532D" },
    { label: "Amber", value: "#D97706", color: "#D97706" },
  ];

  viewMount("variations").innerHTML = `
    <div class="view">
      <header class="view-header">
        <div>
          <h1 class="page-title">Niche Variations</h1>
          <p class="view-sub">Multi-canvas — stack up to 100 base designs, describe the niche, generate variations of each.</p>
        </div>
      </header>

      <div class="nv-split-grid">
        <section class="nv-panel nv-card">
          <div class="stage-head">
            <span class="stage-title">Your designs</span>
            <span class="stage-counter" id="nvCounter">0 / 100</span>
          </div>

          <div class="multi-dropzone" id="nvDrop">
            <i data-lucide="upload-cloud"></i>
            <p><strong>Drop designs here or click to browse</strong></p>
            <p class="dropzone-hint">Multiple files accepted — up to 100 · or press <kbd>Ctrl</kbd> + <kbd>V</kbd> to paste</p>
            <input type="file" id="nvFileInput" accept="image/*" multiple hidden />
          </div>

          <div class="stage-actions">
            <button type="button" class="btn secondary btn-sm" id="nvAddMore"><i data-lucide="plus"></i> Add more</button>
            <button type="button" class="btn secondary btn-sm" id="nvReplace"><i data-lucide="rotate-ccw"></i> Replace</button>
            <button type="button" class="btn secondary btn-sm" id="nvClearAll" style="color: var(--color-danger, #ef4444);"><i data-lucide="trash-2"></i> Delete all</button>
          </div>

          <div class="thumbs-row hidden" id="nvThumbs"></div>
        </section>

        <section class="nv-panel">
          <div class="stage-head">
            <span class="stage-title">Variations</span>
            <span class="stage-counter">1–100</span>
          </div>

          <div class="field">
            <label class="field-label" for="nvCount">Variations per design</label>
            <input type="number" id="nvCount" min="1" max="100" value="4" />
          </div>

          <div class="field">
            <label class="field-label" for="nvNiches">Add your ideas</label>
            <textarea id="nvNiches" class="prompt-editor" placeholder="Describe the new niche, theme, or audience (e.g. Christmas holiday, Retro 90s gaming, Vintage fishing, Dog lover)..."></textarea>
          </div>

          <div class="manual-style-field">
            <label class="manual-style-label" for="nvManualStyle">Style (Optional — auto-pick or type/paste)</label>
            <div class="style-input-group">
              <input type="text" id="nvManualStyle" class="manual-style-input" placeholder="e.g. Vintage Japanese Woodblock, Retro 70s, Cyberpunk..." />
              <button type="button" class="clear-style-btn" data-clear="nvManualStyle">×</button>
            </div>
          </div>

          <div class="magic-style-container" id="nvMagicStyle">
            <button type="button" class="magic-style-btn" id="nvMagicBtn">${MAGIC_STYLE_BTN_DEFAULT}</button>
            <button type="button" class="btn secondary btn-sm magic-style-apply-all hidden" id="nvApplyAll" title="Apply the picked style to every design"><i data-lucide="wand-2"></i> Apply one style to all</button>
          </div>

          ${renderShapeSelector("nv")}

          <div class="field">
            <div class="stage-head">
              <span class="field-label">Background colour</span>
              <button type="button" class="btn secondary btn-sm" id="nvResetBg"><i data-lucide="rotate-ccw"></i> Reset</button>
            </div>
            <div class="swatch-row" id="nvSwatches">
              ${BG_SWATCHES.map((s) => `
                <button type="button" class="swatch ${s.isTransparent ? 'transparent active' : ''}"
                  data-val="${s.value}"
                  title="${s.label}"
                  aria-label="${s.label}"
                  style="${s.color ? `background-color: ${s.color};` : ''}">
                </button>
              `).join("")}
              <div class="swatch-custom" id="nvCustomSwatch">
                <input type="color" id="nvColorPicker" value="#ffffff" aria-label="Custom background colour" />
                <input type="text" id="nvColorHex" value="#FFFFFF" spellcheck="false" aria-label="Custom background hex value" />
              </div>
            </div>
          </div>
        </section>
      </div>

      <div class="nv-action-bar">
        <span class="nv-action-summary" id="nvSummary">0 design(s) in · 0 variation(s) out</span>
        <div class="nv-action-buttons">
          <button class="btn primary" id="nvGenerate"><i data-lucide="sparkles"></i> Generate</button>
          <button class="btn secondary" id="nvStop" disabled><i data-lucide="square"></i> Stop</button>
        </div>
      </div>

      <div class="progress-area hidden" id="nvProgress">
        <p class="progress-line"><i data-lucide="refresh-cw"></i> <span>Generating variations...</span></p>
        <p class="progress-account hidden" id="nvAccountLine"></p>
        <div class="progress-bar"><span class="progress-fill" id="nvProgressFill" style="width:0%"></span></div>
      </div>

      <section class="nv-results-section hidden" id="nvResultsSection">
        <div class="results-head">
          <span>Saved to your library. <a class="text-link" id="nvOpenLibrary" href="#">Open library</a></span>
          <span class="results-count" id="nvOutCount">0 generated</span>
        </div>
        <div class="nv-results-grid" id="nvResults"></div>
      </section>
    </div>`;

  renderIcons();

  const getNvShape = bindShapeSelector("nv");
  const dropzone = $("#nvDrop");
  const fileInput = $("#nvFileInput");
  const thumbsRow = $("#nvThumbs");
  const counter = $("#nvCounter");
  const summary = $("#nvSummary");
  const countInput = $("#nvCount");
  const nichesInput = $("#nvNiches");
  const generateBtn = $("#nvGenerate");
  const stopBtn = $("#nvStop");
  const progressLine = $("#nvProgress");
  const accountLine = $("#nvAccountLine");

  magicStyle = setupMagicStyle({
    btn: $("#nvMagicBtn"),
    container: $("#nvMagicStyle"),
    getContext: () => ({
      prompt: nichesInput.value.trim(),
      imageFile: baseFiles[0] || null,
    }),
    onStyle: (name) => {
      const input = $("#nvManualStyle");
      if (input) input.value = name;
    },
    // Manual-only analysis: runs the per-design batch analyzer EXCLUSIVELY
    // when the user clicks "Magic Style — Auto Pick". Uploads never trigger
    // a network request on their own — thumbnails preview instantly and stay
    // idle until this button is pressed.
    onPick: async () => {
      if (baseFiles.length === 0) {
        alert("Upload at least one design first so Magic Style can analyze it.");
        return null;
      }
      analyzing = true;
      renderThumbs();
      try {
        const analyses = await analyzeDesigns(baseFiles, () => { });
        // Align by designIndex in case files changed mid-flight.
        const next = baseFiles.map(() => null);
        analyses.forEach((a) => {
          if (a.designIndex >= 0 && a.designIndex < next.length) next[a.designIndex] = a;
        });
        designAnalyses = next;
        // Surface the first design's style as the global pick too, so the
        // badge + "Apply one style to all" reflect a concrete style.
        const first = analyses.find((a) => a.primaryStyle);
        return first ? first.primaryStyle : null;
      } finally {
        analyzing = false;
        renderThumbs();
      }
    },
  });

  // "Apply one style to all" — explicit global override. Copies the picked
  // style onto every design's analysis so generation uses it for all inputs.
  const applyAllBtn = $("#nvApplyAll");
  if (applyAllBtn) {
    applyAllBtn.addEventListener("click", () => {
      const style = magicStyle.get();
      if (!style || baseFiles.length === 0) return;
      designAnalyses = baseFiles.map(() => ({
        designIndex: 0,
        primaryStyle: { id: style.id, name: style.name, description: style.directive },
        alternativeStyles: [],
        visualKeypoints: ["Applied globally to all designs."],
        commercialNicheAngle: "",
      }));
      renderThumbs();
    });
    // Show the button whenever a global style is picked (badge present).
    const refreshApplyAll = () => {
      const hasStyle = !!magicStyle.get();
      applyAllBtn.classList.toggle("hidden", !hasStyle);
    };
    const badgeObserver = new MutationObserver(refreshApplyAll);
    badgeObserver.observe($("#nvMagicStyle"), { childList: true, subtree: true });
    refreshApplyAll();
  }

  // Live "which account is generating" — reads the real `status: "generating"`
  // rows off /api/accounts while a batch runs (accounts rotate under the
  // concurrency cap, so several can generate at once). Best-effort: any fetch
  // hiccup just hides the line, never disturbs the batch.
  let accountPoll = null;
  async function refreshAccountLine() {
    try {
      const data = await api("/api/accounts");
      const busy = (data.accounts || []).filter((a) => a.status === "generating");
      if (busy.length === 0) {
        accountLine.textContent = "";
        accountLine.classList.add("hidden");
        return;
      }
      const names = busy.map((a) => (a.email || "").trim() || "Google account");
      accountLine.textContent = names.length === 1
        ? `Generating on ${names[0]}`
        : `Generating on ${names[0]} +${names.length - 1} more`;
      accountLine.classList.remove("hidden");
    } catch {
      accountLine.classList.add("hidden");
    }
  }
  function startAccountPoll() {
    refreshAccountLine();
    accountPoll = setInterval(refreshAccountLine, 2500);
  }
  function stopAccountPoll() {
    if (accountPoll) {
      clearInterval(accountPoll);
      accountPoll = null;
    }
    accountLine.textContent = "";
    accountLine.classList.add("hidden");
  }

  function updateSummary() {
    const vCount = Math.min(100, Math.max(1, parseInt(countInput.value, 10) || 1));
    const totalOut = baseFiles.length * vCount;
    counter.textContent = `${baseFiles.length} / 100`;
    summary.textContent = `${baseFiles.length} design(s) in · ${totalOut} variation(s) out`;
  }

  function renderThumbs() {
    if (baseFiles.length === 0) {
      thumbsRow.classList.add("hidden");
      thumbsRow.innerHTML = "";
    } else {
      thumbsRow.classList.remove("hidden");
      thumbsRow.innerHTML = baseFiles.map((file, idx) => `
        <div class="thumb-card" data-idx="${idx}">
          <img src="${URL.createObjectURL(file)}" alt="thumb" />
          ${styleBadgeHtml(designAnalyses[idx], analyzing)}
          <button type="button" class="thumb-del" data-del="${idx}" title="Remove"><i data-lucide="x"></i></button>
        </div>
      `).join("");
      renderIcons();
    }
    updateSummary();
  }

  function addFiles(newFiles) {
    const combined = [...baseFiles, ...Array.from(newFiles)].slice(0, 100);
    baseFiles = combined;
    // No automatic style analysis on upload — thumbnails preview instantly
    // and stay idle until the user clicks "Magic Style — Auto Pick".
    designAnalyses = baseFiles.map(() => null);
    renderThumbs();
  }

  bindDropAndPasteZone({
    dropzoneEl: dropzone,
    inputEl: fileInput,
    onFileReceived: addFiles,
  });

  $("#nvAddMore").addEventListener("click", () => fileInput.click());
  $("#nvClearAll")?.addEventListener("click", () => {
    baseFiles = [];
    fileInput.value = "";
    renderThumbs();
  });
  $("#nvReplace").addEventListener("click", () => {
    baseFiles = [];
    fileInput.value = "";
    fileInput.click();
  });

  thumbsRow.addEventListener("click", (e) => {
    const delBtn = e.target.closest("[data-del]");
    if (delBtn) {
      const idx = parseInt(delBtn.dataset.del, 10);
      baseFiles.splice(idx, 1);
      designAnalyses.splice(idx, 1);
      renderThumbs();
      return;
    }
    const popBtn = e.target.closest("[data-style-pop]");
    if (popBtn) {
      const idx = parseInt(popBtn.dataset.stylePop, 10);
      const analysis = designAnalyses[idx];
      if (!analysis) return;
      // Toggle the popover card for this design.
      const existing = thumbsRow.querySelector(`.style-popover[data-style-pop="${idx}"]`);
      thumbsRow.querySelectorAll(".style-popover").forEach((p) => p.remove());
      if (!existing) {
        const card = popBtn.closest(".thumb-card");
        const pop = document.createElement("div");
        pop.innerHTML = stylePopoverHtml(analysis);
        card.appendChild(pop.firstElementChild);
        renderIcons();
      }
      return;
    }
    const altChip = e.target.closest(".style-alt-chip");
    if (altChip) {
      const pop = altChip.closest(".style-popover");
      const idx = parseInt(pop.dataset.stylePop, 10);
      const analysis = designAnalyses[idx];
      if (!analysis) return;
      // Swap the primary style for THIS design to the clicked alternative.
      const alt = analysis.alternativeStyles.find((a) => a.id === altChip.dataset.altId);
      if (!alt) return;
      const newPrimary = { id: alt.id, name: alt.name, description: analysis.primaryStyle.description };
      const newAlts = [
        { id: analysis.primaryStyle.id, name: analysis.primaryStyle.name },
        ...analysis.alternativeStyles.filter((a) => a.id !== alt.id),
      ].slice(0, 3);
      designAnalyses[idx] = {
        ...analysis,
        primaryStyle: newPrimary,
        alternativeStyles: newAlts,
      };
      renderThumbs();
      return;
    }
    const popClose = e.target.closest(".style-pop-close");
    if (popClose) {
      popClose.closest(".style-popover").remove();
    }
  });

  countInput.addEventListener("input", updateSummary);

  $$("#nvSwatches .swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#nvSwatches .swatch").forEach((b) => b.classList.remove("active"));
      $("#nvCustomSwatch").classList.remove("active");
      btn.classList.add("active");
      selectedBg = btn.dataset.val;
    });
  });

  const colorPicker = $("#nvColorPicker");
  const colorHex = $("#nvColorHex");
  const customSwatch = $("#nvCustomSwatch");

  colorPicker.addEventListener("input", (e) => {
    $$("#nvSwatches .swatch").forEach((b) => b.classList.remove("active"));
    customSwatch.classList.add("active");
    colorHex.value = e.target.value.toUpperCase();
    selectedBg = e.target.value;
  });

  colorHex.addEventListener("change", (e) => {
    let val = e.target.value.trim();
    if (!val.startsWith("#")) val = "#" + val;
    colorPicker.value = val;
    colorHex.value = val.toUpperCase();
    $$("#nvSwatches .swatch").forEach((b) => b.classList.remove("active"));
    customSwatch.classList.add("active");
    selectedBg = val;
  });

  // Reset clears back to transparent, which is the view's opening state.
  $("#nvResetBg").addEventListener("click", () => {
    selectedBg = "transparent";
    $$("#nvSwatches .swatch").forEach((b) => b.classList.remove("active"));
    customSwatch.classList.remove("active");
    $("#nvSwatches .swatch[data-val='transparent']")?.classList.add("active");
  });

  $("#nvOpenLibrary").addEventListener("click", (e) => {
    e.preventDefault();
    showView("designs");
  });

  generateBtn.addEventListener("click", async () => {
    if (baseFiles.length === 0) return alert("Please upload at least 1 base design.");
    const nicheText = nichesInput.value.trim();
    if (!nicheText) return alert("Please describe your niche ideas.");

    const count = Math.min(100, Math.max(1, parseInt(countInput.value, 10) || 1));

    abortController = new AbortController();
    generateBtn.disabled = true;
    stopBtn.disabled = false;
    progressLine.classList.remove("hidden");
    const labelEl = progressLine.querySelector("span");
    // Continuous progress engine — one simulated curve per design.
    tracker = new GenerationProgressTracker({
      barEl: $("#nvProgressFill"),
      labelEl,
      totalItems: baseFiles.length,
    });
    tracker.stop();
    labelEl.textContent = `Generating variations across ${baseFiles.length} design(s)...`;
    startAccountPoll();

    const allDesigns = [];
    // The gallery is hidden until the first run — reveal it and clear the
    // previous batch's cards.
    $("#nvResultsSection").classList.remove("hidden");
    $("#nvResults").innerHTML = "";
    $("#nvOutCount").textContent = "0 generated";
    // Instant skeleton placeholders — one per expected output.
    const totalTasks = baseFiles.length * count;
    activeTotalSlots = totalTasks;
    renderPlaceholders($("#nvResults"), totalTasks, "nv-slot");

    try {
      for (let i = 0; i < baseFiles.length; i++) {
        if (abortController.signal.aborted) break;
        tracker.startItem(i);

        const fd = new FormData();
        fd.append("source", baseFiles[i]);
        fd.append("niche", nicheText);
        fd.append("count", count);
        fd.append("bg_color", selectedBg);
        fd.append("aspectRatio", getNvShape());
        // Per-design style takes priority; falls back to the global pick.
        const perDesign = designAnalyses[i];
        appendMagicStyle(fd, perDesign?.primaryStyle || magicStyle.get());
        fd.append("manualStyle", ($("#nvManualStyle")?.value || "").trim());

        // Stream each finished design back as it completes on the fleet.
        await fetchStreamNDJSON(
          "/api/generate/niche-variations",
          { method: "POST", body: fd, signal: abortController.signal },
          (payload) => {
            if (payload.event === "design" && payload.design) {
              const globalSlot = i * count + (payload.slotIndex || 0);
              resolvePlaceholder(`nv-slot-${globalSlot}`, payload.design);
              allDesigns.push(payload.design);
              $("#nvOutCount").textContent = `${allDesigns.length} generated`;
            } else if (payload.event === "slot_failed") {
              const globalSlot = i * count + (payload.slotIndex || 0);
              failPlaceholder(`nv-slot-${globalSlot}`, payload.error || "Generation failed");
            } else if (payload.event === "error") {
              console.error(`Design ${i + 1} error:`, payload.error);
              for (let s = 0; s < count; s++) {
                failPlaceholder(`nv-slot-${i * count + s}`, payload.error || "Failed");
              }
            }
          }
        );
        tracker.finishItem(i);
      }
      tracker.completeAll();
    } catch (err) {
      if (err.name !== "AbortError") {
        alert("Generation stopped or failed: " + err.message);
      }
      cancelAllPlaceholders($("#nvResults"), err.name === "AbortError" ? "Cancelled" : (err.message || "Failed"));
    } finally {
      generateBtn.disabled = false;
      stopBtn.disabled = true;
      progressLine.classList.add("hidden");
      stopAccountPoll();
      abortController = null;
      refreshAccountsData();
    }
  });

  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;

    // 1. Instantly abort local fetch stream
    if (abortController) {
      try { abortController.abort(); } catch (_) { }
    }

    // 2. Instantly cancel all placeholders currently present in the DOM
    cancelAllPlaceholders($("#nvResults"), "Cancelled");

    // 3. Instantly stop progress animation & restore generate button
    if (tracker && typeof tracker.stop === "function") {
      tracker.stop();
    }
    generateBtn.disabled = false;

    const progressLabel = progressLine.querySelector("span");
    if (progressLabel) {
      progressLabel.textContent = "Generation stopped";
    }

    // 4. Fire-and-forget backend cancel beacon (DO NOT await before UI update)
    fetch("/api/generate/cancel", { method: "POST" })
      .catch((err) => console.warn("Cancel signal delivery failed:", err))
      .finally(() => {
        if (typeof startAccountPoll === "function") {
          startAccountPoll();
        }
      });
  });
}

/* ── Magic Listing View ──────────────────────────────────── */

function renderMagicListing() {
  let listingFiles = [];
  let abortController = null;
  // Hoisted so the Stop handler can stop the progress engine.
  let tracker = null;
  // FIX: Declare allListings — was previously an implicit global.
  let allListings = [];
  // Platform mode: "amazon" (default) | "teepublic" — swaps the prompt schema
  // on the backend and the result-card fields on the frontend.
  let currentPlatform = "amazon";

  const PLATFORM_SUBTITLES = {
    amazon: "Vision-powered Amazon Merch on Demand listings — Brand, Title, Bullets, and Description.",
    teepublic: "Vision-powered TeePublic listings — Title, Description, Main Tag, and Supporting Tags.",
    etsy: "Vision-powered Etsy listings — Title (140 chars), Category, Attributes, 13 Tags, and Description.",
  };

  viewMount("magicListing").innerHTML = `
    <div class="view">
      <header class="view-header">
        <div>
          <h1 class="page-title">Magic Listing</h1>
          <p class="view-sub" id="mlSubtitle">Vision-powered Amazon Merch on Demand listings — Brand, Title, Bullets, and Description.</p>
        </div>
        <div class="platform-toggle" id="mlPlatformToggle">
          <button type="button" class="platform-toggle-btn active" data-platform="amazon">Amazon Merch</button>
          <button type="button" class="platform-toggle-btn" data-platform="teepublic">TeePublic</button>
          <button type="button" class="platform-toggle-btn" data-platform="etsy">Etsy</button>
        </div>
      </header>

      <div class="ml-workspace">
        <section class="ml-panel">
          <div class="stage-head">
            <span class="stage-title">Your designs</span>
            <span class="stage-counter" id="mlCounter">0 / 100</span>
          </div>

          <div class="multi-dropzone" id="mlDrop">
            <i data-lucide="upload-cloud"></i>
            <p><strong>Drop designs here or click to browse</strong></p>
            <p class="dropzone-hint">Multiple files accepted — up to 100 · or press <kbd>Ctrl</kbd> + <kbd>V</kbd> to paste</p>
            <input type="file" id="mlFileInput" accept="image/*" multiple hidden />
          </div>

          <div class="thumbs-row hidden" id="mlThumbs"></div>

          <div class="stage-actions ml-stage-actions">
            <button type="button" class="btn secondary btn-sm" id="mlAddMore"><i data-lucide="plus"></i> Add more</button>
            <button type="button" class="btn secondary btn-sm" id="mlFromLibrary"><i data-lucide="library"></i> From My Designs</button>
            <button type="button" class="btn secondary btn-sm" id="mlReplace"><i data-lucide="rotate-ccw"></i> Replace</button>
            <button type="button" class="btn secondary btn-sm" id="mlClearAll" style="color: var(--color-danger, #ef4444);"><i data-lucide="trash-2"></i> Delete all</button>
          </div>
        </section>

        <section class="ml-panel">
          <div class="stage-head">
            <span class="stage-title">Reference data</span>
            <div class="stage-head-right">
              <button type="button" class="refdata-clear-btn" id="mlRefClearAll" title="Clear all reference data">
                <i data-lucide="trash-2"></i> Clear all
              </button>
              <span class="stage-counter">optional</span>
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="mlRefData">Keywords / niche notes (CSV, TXT or JSON)</label>
            <div class="refdata-drop" id="mlRefDrop">
              <div class="refdata-file-pill hidden" id="mlRefFilePill">
                <span class="refdata-file-icon">📄</span>
                <span class="refdata-file-name" id="mlRefFileName" title=""></span>
                <button type="button" class="refdata-file-delete" id="mlRefFileDelete" title="Remove file" aria-label="Remove file"><i data-lucide="x"></i></button>
              </div>
              <textarea id="mlRefData" class="prompt-editor" placeholder="e.g. funny cat mom, sarcastic, cottagecore, vintage botanical, USA, birthday..."></textarea>
              <div class="refdata-footer">
                <button type="button" class="btn secondary btn-sm" id="mlRefBrowse"><i data-lucide="upload"></i> Upload file</button>
                <input type="file" id="mlRefFileInput" multiple accept=".txt,.csv,.json,.tsv,.md,text/plain,text/csv,application/json,text/tab-separated-values,text/markdown" hidden />
              </div>
              <p class="refdata-hint">Drop a .txt / .csv / .json / .tsv / .md file here, or paste keywords directly. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the last change.</p>
            </div>
          </div>

          <div class="action-row">
            <button class="btn primary" id="mlGenerate"><i data-lucide="tag"></i> Generate Listings</button>
            <button class="btn secondary" id="mlStop" disabled><i data-lucide="square"></i> Stop</button>
          </div>

          <div class="progress-area hidden" id="mlProgressArea">
            <p class="progress-line" id="mlProgress"><i data-lucide="refresh-cw"></i> <span>Generating listings…</span></p>
            <div class="progress-bar"><span class="progress-fill" id="mlProgressFill" style="width:0%"></span></div>
          </div>
        </section>
      </div>

      <section class="ml-results-section hidden" id="mlResultsSection">
        <div class="results-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;">
          <div>
            <span>Saved to your library. <a class="text-link" id="mlOpenLibrary" href="#">Open library</a></span>
            <span class="results-count" id="mlOutCount" style="margin-left:0.75rem;">0 listings</span>
          </div>
          <button type="button" id="btn-download-listings-csv" class="btn btn-secondary btn-sm hidden">
            <i data-lucide="download"></i> Download CSV
          </button>
        </div>
        <div class="ml-results-grid" id="mlResults"></div>
      </section>
    </div>`;

  renderIcons();

  const dropzone = $("#mlDrop");
  const fileInput = $("#mlFileInput");
  const thumbsRow = $("#mlThumbs");
  const counter = $("#mlCounter");
  const refData = $("#mlRefData");
  const refDrop = $("#mlRefDrop");
  const refBrowse = $("#mlRefBrowse");
  const refFileInput = $("#mlRefFileInput");
  const refFilePill = $("#mlRefFilePill");
  const refFileName = $("#mlRefFileName");
  const refFileDelete = $("#mlRefFileDelete");
  const generateBtn = $("#mlGenerate");
  const stopBtn = $("#mlStop");
  const progressLine = $("#mlProgress");
  const progressArea = $("#mlProgressArea");

  // ── Platform toggle (Amazon Merch ⇄ TeePublic) ─────────────
  // Swapping platforms only re-labels the subtitle + active pill; the upload,
  // reference data, and generation workflow stay identical. The active mode
  // rides along in the generate payload so the backend picks the right prompt.
  const platformToggle = $("#mlPlatformToggle");
  const subtitle = $("#mlSubtitle");
  platformToggle?.addEventListener("click", (e) => {
    const btn = e.target.closest(".platform-toggle-btn");
    if (!btn || btn.dataset.platform === currentPlatform) return;
    currentPlatform = btn.dataset.platform;
    platformToggle.querySelectorAll(".platform-toggle-btn").forEach((b) =>
      b.classList.toggle("active", b === btn)
    );
    if (subtitle) subtitle.textContent = PLATFORM_SUBTITLES[currentPlatform] || "";
  });

  // ── Reference data: drag-and-drop + file upload + undo ──────
  // Accepts .txt / .csv / .json / .tsv (and any text-ish file). The file is
  // read as plain text and loaded straight into the textarea; JSON files are
  // pretty-printed when valid, otherwise the raw text is kept. The drop
  // target highlights on dragover and shows a dedicated file pill with a
  // delete button. Ctrl+Z / Cmd+Z restores the previous (text + file) state.
  const REF_EXT_RE = /\.(txt|csv|json|tsv|md|log|text)$/i;

  // Undo history: every state-changing action (file load, file delete, paste,
  // manual edit) pushes { text, fileName } so Ctrl+Z can step back. The stack
  // is capped at 20 entries to keep memory bounded.
  const refUndoStack = [];
  const REF_UNDO_MAX = 20;
  let refLoadedFiles = []; // array of { name }

  function pushRefUndo() {
    refUndoStack.push({ text: refData.value, fileNames: refLoadedFiles.map(f => f.name) });
    if (refUndoStack.length > REF_UNDO_MAX) refUndoStack.shift();
  }

  function renderRefFilePill() {
    if (refLoadedFiles.length > 0) {
      const label = refLoadedFiles.length === 1
        ? refLoadedFiles[0].name
        : `${refLoadedFiles.length} files attached (${refLoadedFiles.map(f => f.name).join(", ")})`;
      refFileName.textContent = refLoadedFiles.length === 1 ? refLoadedFiles[0].name : `${refLoadedFiles.length} reference files`;
      refFileName.title = label;
      refFilePill.classList.remove("hidden");
      refDrop.classList.add("has-file");
    } else {
      refFileName.textContent = "";
      refFileName.title = "";
      refFilePill.classList.add("hidden");
      refDrop.classList.remove("has-file");
    }
  }

  async function loadRefFiles(fileList) {
    if (!fileList || !fileList.length) return;
    pushRefUndo();

    const files = Array.from(fileList);
    const readPromises = files.map(file => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          let text = String(reader.result || "").trim();
          if (/\.json$/i.test(file.name)) {
            try {
              text = JSON.stringify(JSON.parse(text), null, 2);
            } catch { /* keep raw */ }
          }
          resolve({ name: file.name, text });
        };
        reader.onerror = () => resolve({ name: file.name, text: "" });
        reader.readAsText(file);
      });
    });

    const results = await Promise.all(readPromises);
    const validResults = results.filter(r => r.text);

    // Merge contents into textarea separated by clear markers
    const appendedText = validResults.map(r => `/* --- File: ${r.name} --- */\n${r.text}`).join("\n\n");
    refData.value = refData.value.trim() ? `${refData.value.trim()}\n\n${appendedText}` : appendedText;

    validResults.forEach(r => {
      if (!refLoadedFiles.some(existing => existing.name === r.name)) {
        refLoadedFiles.push({ name: r.name });
      }
    });

    renderRefFilePill();
  }

  function clearRefFile() {
    pushRefUndo();
    refData.value = "";
    refLoadedFiles = [];
    renderRefFilePill();
  }

  function undoRefState() {
    const prev = refUndoStack.pop();
    if (!prev) return;
    refData.value = prev.text;
    refLoadedFiles = (prev.fileNames || []).map(name => ({ name }));
    renderRefFilePill();
  }

  refBrowse.addEventListener("click", () => refFileInput.click());
  refFileInput.addEventListener("change", () => {
    if (refFileInput.files.length) loadRefFiles(refFileInput.files);
    refFileInput.value = ""; // allow re-selecting the same files
  });
  refFileDelete.addEventListener("click", clearRefFile);

  // "Clear all" — safe, data-only reset of the reference data card. Wipes the
  // textarea (with input/change events so reactive counters and undo hooks
  // register the empty string), clears the file input + pill, and resets the
  // in-memory file list. The dropzone, helper text, and action buttons stay
  // untouched — only user-entered data is removed.
  const refClearAll = $("#mlRefClearAll");
  refClearAll?.addEventListener("click", () => {
    pushRefUndo(); // snapshot so Ctrl+Z can restore the pre-clear state
    refData.value = "";
    refData.dispatchEvent(new Event("input", { bubbles: true }));
    refData.dispatchEvent(new Event("change", { bubbles: true }));
    refFileInput.value = "";
    refLoadedFiles = [];
    renderRefFilePill();
  });

  // Ctrl+Z / Cmd+Z inside the reference data area — restore the previous
  // (text + file) state and stop the browser's native truncation.
  refDrop.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undoRefState();
    }
  });

  // Track manual edits + pastes so Ctrl+Z can step back through them too.
  refData.addEventListener("input", () => pushRefUndo());
  refData.addEventListener("paste", () => {
    // Defer so the paste lands in the textarea before we snapshot it.
    setTimeout(pushRefUndo, 0);
  });

  refDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    refDrop.classList.add("drag");
  });
  refDrop.addEventListener("dragleave", () => refDrop.classList.remove("drag"));
  refDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    refDrop.classList.remove("drag");
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => REF_EXT_RE.test(f.name));
    if (file) {
      loadRefFiles([file]);
    } else if (e.dataTransfer?.files?.length) {
      alert("Unsupported file type — drop a .txt, .csv, .json or .tsv file.");
    }
  });

  function updateCounter() {
    counter.textContent = `${listingFiles.length} / 100`;
  }

  function renderThumbs() {
    if (listingFiles.length === 0) {
      thumbsRow.classList.add("hidden");
      thumbsRow.innerHTML = "";
    } else {
      thumbsRow.classList.remove("hidden");
      thumbsRow.innerHTML = listingFiles.map((file, idx) => `
        <div class="thumb-card" data-idx="${idx}">
          <img src="${URL.createObjectURL(file)}" alt="thumb" />
          <button type="button" class="thumb-del" data-del="${idx}" title="Remove"><i data-lucide="x"></i></button>
        </div>
      `).join("");
      renderIcons();
    }
    updateCounter();
  }

  function addFiles(newFiles) {
    listingFiles = [...listingFiles, ...Array.from(newFiles)].slice(0, 100);
    renderThumbs();
  }

  bindDropAndPasteZone({
    dropzoneEl: dropzone,
    inputEl: fileInput,
    onFileReceived: addFiles,
  });

  $("#mlAddMore").addEventListener("click", () => fileInput.click());
  $("#mlFromLibrary").addEventListener("click", () => {
    openLibraryPicker({
      currentCount: listingFiles.length,
      onConfirm: (files) => addFiles(files),
    });
  });
  $("#mlClearAll")?.addEventListener("click", () => {
    listingFiles = [];
    fileInput.value = "";
    renderThumbs();
  });
  $("#mlReplace").addEventListener("click", () => {
    listingFiles = [];
    fileInput.value = "";
    fileInput.click();
  });

  thumbsRow.addEventListener("click", (e) => {
    const delBtn = e.target.closest("[data-del]");
    if (!delBtn) return;
    const idx = parseInt(delBtn.dataset.del, 10);
    listingFiles.splice(idx, 1);
    renderThumbs();
  });

  $("#mlOpenLibrary").addEventListener("click", (e) => {
    e.preventDefault();
    showView("designs");
  });

  const downloadCsvBtn = $("#btn-download-listings-csv");
  downloadCsvBtn?.addEventListener("click", () => exportListingsToCSV(allListings));

  // Copy buttons inside listing cards — reuse the studio's clipboard helper.
  $("#mlResults").addEventListener("click", (e) => {
    const btn = e.target.closest(".ml-copy");
    if (!btn) return;
    copyWithFeedback(btn, btn.dataset.copy, btn.title.replace("Copy ", ""));
  });

  generateBtn.addEventListener("click", async () => {
    if (listingFiles.length === 0) return alert("Upload at least one design to generate listings for.");

    abortController = new AbortController();
    generateBtn.disabled = true;
    stopBtn.disabled = false;
    downloadCsvBtn?.classList.add("hidden");
    progressArea.classList.remove("hidden");
    const labelEl = progressLine.querySelector("span");
    // Continuous progress engine — text-mode curve (~8s) for the single
    // batch request. Replaces the frozen "Generating listings…" spinner.
    tracker = new GenerationProgressTracker({
      barEl: $("#mlProgressFill"),
      labelEl,
      totalItems: 1,
      isTextMode: true,
    });
    tracker.stop();
    tracker.startItem("batch");
    labelEl.textContent = "Preparing designs…";
    $("#mlResultsSection").classList.remove("hidden");
    $("#mlResults").innerHTML = "";
    $("#mlOutCount").textContent = "0 listings";

    const referenceData = refData.value.trim();
    allListings.length = 0;

    try {
      // Batch prep: downscale every design ONCE up front (the vision payload
      // for all designs is sent together in a single parallel request), and
      // capture each thumbnail for the result cards.
      const designs = [];
      for (let i = 0; i < listingFiles.length; i++) {
        if (abortController.signal.aborted) break;
        labelEl.textContent = `Preparing design ${i + 1} of ${listingFiles.length}…`;

        const file = listingFiles[i];
        // Full-res data URL for the UI thumbnail…
        const thumbnailUrl = await fileToBase64(file);
        // …but a downscaled JPEG for the AI vision payload, so high-res print
        // files (>15MB) never blow past the server body limit (HTTP 413).
        const visionBase64 = await optimizeImageForVision(file);
        designs.push({
          imageBase64: visionBase64,
          fileName: file.name,
          designIndex: i + 1,
        });
        // Keep the thumbnail paired with the design index for the result cards.
        designs[i].thumbnailUrl = thumbnailUrl;
      }
      if (designs.length === 0) return;

      labelEl.textContent =
        `Fleet distribution: processing ${designs.length} design(s) across all ready accounts in parallel...`;

      const res = await fetch("/api/magic-listing/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          designs,
          referenceData,
          platform: currentPlatform,
        }),
        // FIX: 3-minute client-side timeout prevents the UI from hanging
        // forever at 95% if the backend stops responding.
        signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(180000)]),
      });

      if (!res.ok) {
        let errMsg = `Request failed (${res.status})`;
        try {
          const errJson = await res.json();
          errMsg = errJson.error || errMsg;
        } catch (_) { /* non-JSON error body */ }
        throw new Error(errMsg);
      }
      const data = await res.json();
      if (tracker) {
        tracker.finishItem("batch");
        tracker.completeAll();
      }
      const fillBar = $("#mlProgressFill");
      if (fillBar) fillBar.style.width = "100%";
      labelEl.style.color = "";
      labelEl.textContent = `Completed: ${data.results?.length || 0} listing(s) generated.`;

      // Render successful listings — map back to the prepped thumbnail by index.
      const grid = $("#mlResults");
      (data.results || []).forEach((r) => {
        const item = {
          designIndex: r.designIndex,
          fileName: r.fileName,
          thumbnailUrl: designs.find((d) => d.designIndex === r.designIndex)?.thumbnailUrl || "",
          platform: r.platform || currentPlatform,
          listing: r.listing,
        };
        allListings.push(item);
        if (grid) {
          grid.insertAdjacentHTML("beforeend", magicListingCard(item));
          renderIcons();
        }
        $("#mlOutCount").textContent = `${allListings.length} listing${allListings.length === 1 ? "" : "s"}`;
      });

      if (allListings.length > 0 && downloadCsvBtn) {
        downloadCsvBtn.classList.remove("hidden");
      }

      // Failed designs get an inline card so the user sees exactly which ones
      // were refused/skipped instead of a silent partial batch.
      const failedCount = (data.failed || []).length;
      if (failedCount > 0) {
        (data.failed || []).forEach((f) => {
          if (grid) {
            grid.insertAdjacentHTML("beforeend", `
              <div class="ml-card" style="border-color:rgba(245,158,11,0.4);">
                <div class="ml-card-header">
                  <div class="ml-card-title-group">
                    <span class="ml-index-badge">#${esc(f.designIndex ?? "?")}</span>
                    <span class="ml-file-name">${esc(f.fileName || `Design #${f.designIndex}`)}</span>
                  </div>
                  <span class="ml-card-safe badge-warn"><i data-lucide="alert-triangle"></i> Skipped</span>
                </div>
                <div class="ml-card-body">
                  <p class="ml-field"><strong>Could not process this design</strong><br>${esc(f.error || "Safety refusal or timeout — the rest of the batch completed.")}</p>
                </div>
              </div>`);
          }
        });
        renderIcons();
      }

      if (allListings.length === 0 && failedCount === 0) {
        labelEl.textContent = "No listings were generated. Please try again.";
      }
    } catch (err) {
      if (tracker) tracker.stop();
      if (err.name !== "AbortError") {
        console.error("Magic listing error:", err);
        labelEl.textContent = `Error: ${err.message || err}`;
        labelEl.style.color = "#ef4444";
      } else {
        labelEl.textContent = "Generation cancelled by user.";
        labelEl.style.color = "#f59e0b";
      }
    } finally {
      generateBtn.disabled = false;
      stopBtn.disabled = true;
      abortController = null;
      refreshAccountsData();
    }
  });

  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;

    // 1. Instantly abort local fetch stream
    if (abortController) {
      try { abortController.abort(); } catch (_) { }
    }

    // 2. Instantly cancel all placeholders currently present in the DOM
    const grid = $("#mlResults") || document.querySelector(".results-grid:not(.hidden)");
    if (grid) {
      grid.querySelectorAll(".card-placeholder").forEach((card) => {
        failPlaceholder(card.id, "Cancelled");
      });
    }

    // 3. Instantly stop progress animation & restore generate button
    if (tracker && typeof tracker.stop === "function") {
      tracker.stop();
    }
    generateBtn.disabled = false;

    const progressLabel = progressLine.querySelector("span");
    if (progressLabel) {
      progressLabel.textContent = "Generation stopped";
    }

    // 4. Fire-and-forget backend cancel beacon (DO NOT await before UI update)
    fetch("/api/generate/cancel", { method: "POST" })
      .catch((err) => console.warn("Cancel signal delivery failed:", err))
      .finally(() => {
        if (typeof startAccountPoll === "function") {
          startAccountPoll();
        }
      });
  });
}

/** Export structured listing data to an RFC-4180 compliant CSV file. */
function exportListingsToCSV(listingsData) {
  if (!listingsData || !listingsData.length) return;

  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val);
    return `"${str.replace(/"/g, '""')}"`;
  };

  const headers = [
    "Design ID",
    "File Name",
    "Platform",
    "Title",
    "Brand / Store",
    "Category",
    "Bullet 1",
    "Bullet 2",
    "Tags / Keywords",
    "Attributes",
    "Description",
    "Generated At",
  ];

  const rows = listingsData.map((item) => {
    const d = item.listing || {};
    const platform = (item.platform || "amazon").toLowerCase();
    const id = item.designIndex ?? "";
    const fileName = item.fileName || `Design #${id}`;
    const generatedAt = new Date().toISOString();

    let title = d.title || "";
    let brand = "";
    let category = "";
    let bullet1 = "";
    let bullet2 = "";
    let tagsKeywords = "";
    let attributesStr = "";
    let description = d.description || d.desc || "";

    if (platform === "amazon") {
      brand = d.brand || d.brand_name || d.brandName || "";
      bullet1 = d.bullet1 || d.bullet_1 || "";
      bullet2 = d.bullet2 || d.bullet_2 || "";
    } else if (platform === "teepublic") {
      const mainTag = d.mainTag || d.main_tag || "";
      const supporting = Array.isArray(d.supportingTags)
        ? d.supportingTags
        : Array.isArray(d.supporting_tags)
          ? d.supporting_tags
          : [];
      tagsKeywords = [mainTag, ...supporting].filter(Boolean).join(", ");
    } else if (platform === "etsy") {
      category = d.category || "Clothing > Unisex Adult Clothing > Tops & Tees > T-shirts";
      const tags = Array.isArray(d.tags)
        ? d.tags
        : Array.isArray(d.supporting_tags)
          ? d.supporting_tags
          : [];
      tagsKeywords = tags.join(", ");
      if (d.attributes && typeof d.attributes === "object") {
        attributesStr = Object.entries(d.attributes)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" | ");
      }
    }

    return [
      escapeCSV(id),
      escapeCSV(fileName),
      escapeCSV(platform),
      escapeCSV(title),
      escapeCSV(brand),
      escapeCSV(category),
      escapeCSV(bullet1),
      escapeCSV(bullet2),
      escapeCSV(tagsKeywords),
      escapeCSV(attributesStr),
      escapeCSV(description),
      escapeCSV(generatedAt),
    ].join(",");
  });

  const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `magic_listings_export_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Render one Magic Listing result card with copy-to-clipboard affordances.
 *  `item` = { designIndex, fileName, thumbnailUrl, platform, listing }.
 *  Amazon renders Brand/Title/Bullets/Description; TeePublic renders
 *  Title/Description/Main Tag/Supporting Tags with a "Copy All Tags" button;
 *  Etsy renders Title (140 chars), Category, Attributes, 13 Tags, and Description. */
function magicListingCard(item) {
  const data = item.listing || {};
  const isTeePublic = item.platform === "teepublic";
  const isEtsy = item.platform === "etsy";

  const copyBtn = (label, text) => `
    <button type="button" class="btn secondary btn-sm ml-copy" data-copy="${esc(text)}" title="Copy ${label}">
      <i data-lucide="copy"></i> ${label}
    </button>`;

  // ── Etsy card ──────────────────────────────────────────────
  if (isEtsy) {
    const title = data.title || "";
    const category = data.category || "Clothing > Unisex Adult Clothing > Tops & Tees > T-shirts";
    const description = data.description || "";
    const attrs = typeof data.attributes === "object" && data.attributes !== null ? data.attributes : {};
    const tags = Array.isArray(data.tags)
      ? data.tags
      : Array.isArray(data.supporting_tags)
        ? data.supporting_tags
        : [];
    const tagsCsv = tags.join(", ");
    const attrsText = Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join("\n");
    const allText = `Title: ${title}\n\nCategory: ${category}\n\nAttributes:\n${attrsText}\n\nTags (13):\n${tagsCsv}\n\nDescription:\n${description}`;

    return `
      <div class="ml-card">
        <div class="ml-card-header">
          <div class="ml-card-title-group">
            <img src="${esc(item.thumbnailUrl || "")}" class="ml-card-thumb" alt="${esc(item.fileName || "")}" />
            <div class="ml-card-meta">
              <span class="ml-index-badge">#${esc(item.designIndex)}</span>
              <span class="ml-file-name" title="${esc(item.fileName || "")}">${esc(item.fileName || `Design #${item.designIndex}`)}</span>
            </div>
          </div>
          <span class="ml-card-safe ${data.trademark_safe ? "badge-safe" : "badge-warn"}">
            <i data-lucide="shield-check"></i> ${data.trademark_safe ? "Trademark safe" : "Check IP"}
          </span>
        </div>
        <div class="ml-card-body">
          <p class="ml-field"><strong>Title</strong> <span class="ml-chars">${title.length}/140</span><br>${esc(title)}</p>
          <p class="ml-field"><strong>Category</strong><br><span class="ml-tag-pill" style="font-size:0.75rem;">${esc(category)}</span></p>
          <div class="ml-field">
            <strong>Attributes</strong>
            <div class="ml-attributes-grid">
              ${Object.entries(attrs).map(([k, v]) => `
                <div class="ml-attribute-chip">
                  <span class="attr-label">${esc(k)}</span>
                  <span class="attr-val">${esc(v)}</span>
                </div>
              `).join("")}
            </div>
          </div>
          <p class="ml-field"><strong>13 Tags</strong> <span class="ml-chars">${tags.length}/13</span></p>
          <div class="ml-tag-cloud">
            ${tags.map((t) => `<span class="ml-tag-pill">${esc(t)}</span>`).join("")}
          </div>
          <p class="ml-field" style="margin-top:0.6rem;"><strong>Description</strong> <span class="ml-chars">${description.length} chars</span><br><span style="white-space:pre-line;">${esc(description)}</span></p>
        </div>
        <div class="ml-card-actions">
          ${copyBtn("Title", title)}
          ${copyBtn("Category", category)}
          ${copyBtn("Attributes", attrsText)}
          ${copyBtn("Tags", tagsCsv)}
          ${copyBtn("Description", description)}
          ${copyBtn("All", allText)}
        </div>
      </div>`;
  }

  // ── TeePublic card ─────────────────────────────────────────
  if (isTeePublic) {
    const title = data.title || "";
    const description = data.description || "";
    // Consume either key format the backend may emit (snake_case or camelCase).
    const mainTag = data.mainTag || data.main_tag || "";
    const tags = Array.isArray(data.supportingTags)
      ? data.supportingTags
      : Array.isArray(data.supporting_tags)
        ? data.supporting_tags
        : [];
    const tagsCsv = tags.join(", ");
    // "All Tags" = main tag first, then the supporting tags — ready for
    // TeePublic's bulk tag uploader.
    const allTagsCsv = [mainTag, ...tags].filter(Boolean).join(", ");
    const allText = `Title: ${title}\n\nDescription: ${description}\n\nMain Tag: ${mainTag}\n\nTags: ${tagsCsv}`;

    return `
      <div class="ml-card">
        <div class="ml-card-header">
          <div class="ml-card-title-group">
            <img src="${esc(item.thumbnailUrl || "")}" class="ml-card-thumb" alt="${esc(item.fileName || "")}" />
            <div class="ml-card-meta">
              <span class="ml-index-badge">#${esc(item.designIndex)}</span>
              <span class="ml-file-name" title="${esc(item.fileName || "")}">${esc(item.fileName || `Design #${item.designIndex}`)}</span>
            </div>
          </div>
          <span class="ml-card-safe ${data.trademark_safe ? "badge-safe" : "badge-warn"}">
            <i data-lucide="shield-check"></i> ${data.trademark_safe ? "Trademark safe" : "Check IP"}
          </span>
        </div>
        <div class="ml-card-body">
          <p class="ml-field"><strong>Title</strong> <span class="ml-chars">${title.length}/40–80</span><br>${esc(title)}</p>
          <p class="ml-field"><strong>Description</strong> <span class="ml-chars">${description.length}/150–300</span><br>${esc(description)}</p>
          <p class="ml-field"><strong>Main Tag</strong><br><span class="ml-tag-pill">${esc(mainTag || "N/A")}</span></p>
          <p class="ml-field"><strong>Supporting Tags</strong> <span class="ml-chars">${tags.length}/6–15</span></p>
          <div class="ml-tag-cloud">
            ${tags.map((t) => `<span class="ml-tag-pill">${esc(t)}</span>`).join("")}
          </div>
        </div>
        <div class="ml-card-actions">
          ${copyBtn("Title", title)}
          ${copyBtn("Description", description)}
          ${copyBtn("Main Tag", mainTag)}
          ${copyBtn("All Tags", allTagsCsv)}
          ${copyBtn("All", allText)}
        </div>
      </div>`;
  }

  // ── Amazon Merch card (default) ────────────────────────────
  const title = data.title || "";
  const brand = data.brand || data.brand_name || data.brandName || "";
  const bullet1 = data.bullet1 || data.bullet_1 || "";
  const bullet2 = data.bullet2 || data.bullet_2 || "";
  const description = data.description || data.desc || "";

  const allText = `Title: ${title}\nBrand: ${brand}\n\nBullet 1: ${bullet1}\nBullet 2: ${bullet2}\n\nDescription: ${description}`;

  return `
    <div class="ml-card">
      <div class="ml-card-header">
        <div class="ml-card-title-group">
          <img src="${esc(item.thumbnailUrl || "")}" class="ml-card-thumb" alt="${esc(item.fileName || "")}" />
          <div class="ml-card-meta">
            <span class="ml-index-badge">#${esc(item.designIndex)}</span>
            <span class="ml-file-name" title="${esc(item.fileName || "")}">${esc(item.fileName || `Design #${item.designIndex}`)}</span>
          </div>
        </div>
        <span class="ml-card-safe ${data.trademark_safe ? "badge-safe" : "badge-warn"}">
          <i data-lucide="shield-check"></i> ${data.trademark_safe ? "Trademark safe" : "Check IP"}
        </span>
      </div>
      <div class="ml-card-body">
        <p class="ml-field"><strong>Title</strong> <span class="ml-chars">${title.length}/60</span><br>${esc(title)}</p>
        <p class="ml-field"><strong>Brand</strong> <span class="ml-chars">${brand.length}/50</span><br>${esc(brand)}</p>
        <p class="ml-field"><strong>Bullet 1</strong> <span class="ml-chars">${bullet1.length}/256</span><br>${esc(bullet1)}</p>
        <p class="ml-field"><strong>Bullet 2</strong> <span class="ml-chars">${bullet2.length}/256</span><br>${esc(bullet2)}</p>
        <p class="ml-field"><strong>Description</strong> <span class="ml-chars">${description.length}/500</span><br>${esc(description)}</p>
      </div>
      <div class="ml-card-actions">
        ${copyBtn("Title", title)}
        ${copyBtn("Brand", brand)}
        ${copyBtn("Bullets", `${bullet1}\n${bullet2}`)}
        ${copyBtn("Description", description)}
        ${copyBtn("All", allText)}
      </div>
    </div>`;
}

/* ── Art Style + Niche View ──────────────────────────────── */

function renderArtStyleNiche() {
  let abortController = null;
  let activeTotalSlots = 0;
  let tracker = null;

  viewMount("artstyle").innerHTML = `
    <div class="view">
      <header class="view-header">
        <div>
          <h1 class="page-title">Art Style + Niche</h1>
          <p class="view-sub">Fuse multiple style references into a cohesive moodboard aesthetic, or pair them 1-to-1 across your ready fleet.</p>
        </div>
      </header>

      <div class="card panel feature-card as-card">
        <div class="as-mode-row" style="position:relative;display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1rem;padding:0.75rem 1rem;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:1.25rem;flex-wrap:wrap;">
              <span class="field-label" style="font-weight:600;font-size:0.85rem;margin:0;color:var(--text-main,#f8fafc);">Mode:</span>
              <label id="lblModeFusion" title="Blends all style references into a single moodboard aesthetic." style="display:inline-flex;align-items:center;gap:0.45rem;cursor:pointer;font-size:0.85rem;padding:0.25rem 0.5rem;border-radius:6px;transition:background 0.15s ease;">
                <input type="radio" name="asMode" value="fusion" checked />
                <span><strong>Fusion Mode</strong> (Moodboard blend)</span>
              </label>
              <label id="lblModePairwise" title="Tests each style reference independently against each niche." style="display:inline-flex;align-items:center;gap:0.45rem;cursor:pointer;font-size:0.85rem;padding:0.25rem 0.5rem;border-radius:6px;transition:background 0.15s ease;">
                <input type="radio" name="asMode" value="pairwise" />
                <span><strong>Pairwise Mode</strong> (A/B test styles)</span>
              </label>
            </div>
            <button type="button" id="asModeInfoBtn" class="as-mode-info-btn" title="Mode Guide — How It Works" aria-label="Mode Guide — How It Works">
              <i data-lucide="info"></i>
            </button>
          </div>
          <div id="asModeGuidance" style="display:flex;align-items:center;gap:0.45rem;font-size:0.78rem;color:#94a3b8;background:rgba(0,0,0,0.2);padding:0.4rem 0.65rem;border-radius:5px;border-left:3px solid #38bdf8;transition:all 0.2s ease;">
            <i data-lucide="info" style="width:14px;height:14px;color:#38bdf8;flex-shrink:0;"></i>
            <span id="asModeGuidanceText">Fusion Mode: Combines all style images into a unified aesthetic moodboard. Gemini synthesizes textures, linework, and palettes into 1 hybrid style applied to your niche.</span>
          </div>
        </div>

        <div class="dropzones-pair">
          <div class="as-side">
            <div class="stage-head">
              <span class="stage-title">Style reference</span>
              <span class="stage-counter" id="asStyleCounter">0 / 100</span>
            </div>
            <div class="multi-dropzone" id="asDropStyle">
              <i data-lucide="upload-cloud"></i>
              <p><strong>Drop designs here or click to browse</strong></p>
              <p class="dropzone-hint">Multiple files accepted — up to 100 · or press <kbd>Ctrl</kbd> + <kbd>V</kbd> to paste</p>
              <input type="file" id="asFileStyle" accept="image/*" multiple hidden />
            </div>
            <div class="stage-actions">
              <button type="button" class="btn secondary btn-sm" id="asStyleAddMore"><i data-lucide="plus"></i> Add more</button>
              <button type="button" class="btn secondary btn-sm" id="asStyleReplace"><i data-lucide="rotate-ccw"></i> Replace</button>
              <button type="button" class="btn secondary btn-sm" id="asStyleClearAll" style="color: var(--color-danger,#ef4444);"><i data-lucide="trash-2"></i> Delete all</button>
            </div>
            <div class="thumbs-row hidden" id="asStyleThumbs"></div>
          </div>

          <div class="as-side">
            <div class="stage-head">
              <span class="stage-title">Niche reference</span>
              <span class="stage-counter" id="asNicheCounter">0 / 100</span>
            </div>
            <div class="multi-dropzone" id="asDropNiche">
              <i data-lucide="upload-cloud"></i>
              <p><strong>Drop designs here or click to browse</strong></p>
              <p class="dropzone-hint">Multiple files accepted — up to 100 · or press <kbd>Ctrl</kbd> + <kbd>V</kbd> to paste</p>
              <input type="file" id="asFileNiche" accept="image/*" multiple hidden />
            </div>
            <div class="stage-actions">
              <button type="button" class="btn secondary btn-sm" id="asNicheAddMore"><i data-lucide="plus"></i> Add more</button>
              <button type="button" class="btn secondary btn-sm" id="asNicheReplace"><i data-lucide="rotate-ccw"></i> Replace</button>
              <button type="button" class="btn secondary btn-sm" id="asNicheClearAll" style="color: var(--color-danger,#ef4444);"><i data-lucide="trash-2"></i> Delete all</button>
            </div>
            <div class="thumbs-row hidden" id="asNicheThumbs"></div>
          </div>
        </div>

        <p class="pair-warning hidden" id="asPairWarning"></p>
        <div class="summary-caption" id="asSummary">0 ready to generate</div>

        <div class="as-outputs-row">
          <label class="field as-outputs-field" for="asVariations">
            <span class="field-label" id="asVariationsLabel">Variations per niche</span>
            <input type="number" id="asVariations" min="1" max="100" value="1" />
          </label>
        </div>

        ${renderShapeSelector("as")}

        <button class="btn primary" id="asGenerate" disabled><i data-lucide="sparkles"></i> Generate</button>
        <button class="btn secondary hidden" id="asStop" disabled><i data-lucide="square"></i> Stop</button>
      </div>

      <div class="progress-area hidden" id="asProgress">
        <p class="progress-line"><i data-lucide="refresh-cw"></i> <span>Fusing style onto niche…</span></p>
        <div class="progress-bar"><span class="progress-fill" id="asProgressFill" style="width:0%"></span></div>
      </div>
      <div class="results" id="asResults"></div>

      <!-- Art Style Mode Guide Modal -->
      <div class="modal-backdrop panel hidden" id="asModeGuideModal" role="dialog" aria-modal="true" aria-labelledby="asModeGuideTitle">
        <div class="modal as-guide-modal" id="asModeGuideDialog" style="width: min(620px, 94vw); max-height: 88vh; overflow-y: auto; padding: 24px 28px; position: relative; border-radius: 16px; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
          <button type="button" class="modal-close" id="asModeGuideClose" title="Close" aria-label="Close mode guide" style="position: absolute; top: 18px; right: 18px; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer;">
            <i data-lucide="x" style="width: 18px; height: 18px;"></i>
          </button>

          <div style="display:flex; align-items:center; gap:10px; margin-bottom: 6px;">
            <span style="display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:8px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3);">
              <i data-lucide="book-open" style="width:16px; height:16px;"></i>
            </span>
            <h2 class="modal-title" id="asModeGuideTitle" style="margin:0; font-size:1.25rem; font-weight:700;">Mode Guide — How It Works</h2>
          </div>
          <p class="modal-sub" style="margin:0 0 20px 0; font-size:0.85rem; color:#94a3b8; line-height:1.4;">
            Understand the difference between <strong>Fusion Mode</strong> and <strong>Pairwise Mode</strong> to get the exact design output you need.
          </p>

          <!-- Section 1: Fusion Mode -->
          <div class="as-guide-section" style="margin-bottom: 16px; padding: 16px; border-radius: 12px; background: rgba(56,189,248,0.03); border: 1px solid rgba(56,189,248,0.18);">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom: 8px;">
              <span class="badge" style="background:#0284c7; color:#ffffff; font-size:0.75rem; font-weight:700; padding:2px 8px; border-radius:4px; text-transform:uppercase; letter-spacing:0.5px;">Mode 1</span>
              <h3 style="margin:0; font-size:1rem; font-weight:700; color:#38bdf8;">Fusion Mode (Moodboard Blend)</h3>
            </div>
            <p style="margin:0 0 10px 0; font-size:0.85rem; line-height:1.45;">
              <strong>Summary:</strong> Combines all style images into a unified aesthetic moodboard applied to your niche subject.
            </p>
            <div class="as-guide-card" style="background: rgba(0,0,0,0.25); border-radius: 8px; padding: 12px; border: 1px solid rgba(255,255,255,0.06); font-size: 0.8rem; line-height: 1.5;">
              <div style="font-weight: 600; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.5px;">Example Walkthrough</div>
              <div style="display:flex; flex-direction:column; gap:4px;">
                <div>🎨 <strong>Style uploads:</strong> 3 style references (e.g., vintage, grunge, retro palette).</div>
                <div>🎯 <strong>Niche upload:</strong> A cat.</div>
                <div style="margin-top:4px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.1); color:#38bdf8; font-weight:600;">
                  ✨ <strong>Result:</strong> A cat design combining all 3 styles into one unified aesthetic.
                </div>
              </div>
            </div>
          </div>

          <!-- Section 2: Pairwise Mode -->
          <div class="as-guide-section" style="margin-bottom: 20px; padding: 16px; border-radius: 12px; background: rgba(168,85,247,0.03); border: 1px solid rgba(168,85,247,0.18);">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom: 8px;">
              <span class="badge" style="background:#7c3aed; color:#ffffff; font-size:0.75rem; font-weight:700; padding:2px 8px; border-radius:4px; text-transform:uppercase; letter-spacing:0.5px;">Mode 2</span>
              <h3 style="margin:0; font-size:1rem; font-weight:700; color:#c084fc;">Pairwise Mode (A/B Testing)</h3>
            </div>
            <p style="margin:0 0 10px 0; font-size:0.85rem; line-height:1.45;">
              <strong>Summary:</strong> Generates direct 1-to-1 pairings between style references and niche references.
            </p>
            <div class="as-guide-card" style="background: rgba(0,0,0,0.25); border-radius: 8px; padding: 12px; border: 1px solid rgba(255,255,255,0.06); font-size: 0.8rem; line-height: 1.5;">
              <div style="font-weight: 600; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.5px;">Example Walkthrough</div>
              <div style="display:flex; flex-direction:column; gap:4px;">
                <div>📊 <strong>2 styles + 2 niche images:</strong></div>
                <div style="padding-left:12px;">• Style 1 + Cat 1 &rarr; <strong>Design 1</strong></div>
                <div style="padding-left:12px;">• Style 2 + Dog 2 &rarr; <strong>Design 2</strong></div>
                <div style="margin-top:4px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.1); color:#c084fc; font-weight:600;">
                  ✨ <strong>Result:</strong> Separate designs using individual style–niche pairings.
                </div>
              </div>
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end;">
            <button type="button" class="btn secondary" id="asModeGuideGotIt" style="min-width: 90px; padding: 8px 18px; font-size: 0.85rem; border-radius: 8px;">Got it</button>
          </div>
        </div>
      </div>
    </div>`;

  renderIcons();

  const modeInfoBtn = $("#asModeInfoBtn");
  const modeGuideModal = $("#asModeGuideModal");
  const modeGuideClose = $("#asModeGuideClose");
  const modeGuideGotIt = $("#asModeGuideGotIt");

  function openModeGuide() {
    modeGuideModal?.classList.remove("hidden");
    renderIcons();
  }
  function closeModeGuide() {
    modeGuideModal?.classList.add("hidden");
  }

  modeInfoBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (modeGuideModal?.classList.contains("hidden")) {
      openModeGuide();
    } else {
      closeModeGuide();
    }
  });

  modeGuideClose?.addEventListener("click", closeModeGuide);
  modeGuideGotIt?.addEventListener("click", closeModeGuide);

  modeGuideModal?.addEventListener("click", (e) => {
    if (e.target === modeGuideModal) {
      closeModeGuide();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modeGuideModal && !modeGuideModal.classList.contains("hidden")) {
      closeModeGuide();
    }
  });

  const getAsShape = bindShapeSelector("as");

  const sides = {
    style: {
      files: [],
      drop: $("#asDropStyle"),
      input: $("#asFileStyle"),
      addMore: $("#asStyleAddMore"),
      replace: $("#asStyleReplace"),
      thumbs: $("#asStyleThumbs"),
      counter: $("#asStyleCounter"),
    },
    niche: {
      files: [],
      drop: $("#asDropNiche"),
      input: $("#asFileNiche"),
      addMore: $("#asNicheAddMore"),
      replace: $("#asNicheReplace"),
      thumbs: $("#asNicheThumbs"),
      counter: $("#asNicheCounter"),
    },
  };

  const summary = $("#asSummary");
  const warning = $("#asPairWarning");
  const generateBtn = $("#asGenerate");
  const stopBtn = $("#asStop");
  const progress = $("#asProgress");
  const variationsInput = $("#asVariations");

  function getMode() {
    return document.querySelector('input[name="asMode"]:checked')?.value || "fusion";
  }

  function variationsCount() {
    return Math.min(100, Math.max(1, parseInt(variationsInput?.value, 10) || 1));
  }

  function computePairs() {
    const sLen = sides.style.files.length;
    const nLen = sides.niche.files.length;
    if (sLen === 0 || nLen === 0) return 0;
    return (sLen === 1 || nLen === 1) ? Math.max(sLen, nLen) : Math.min(sLen, nLen);
  }

  function updatePairing() {
    const mode = getMode();
    const styleCount = sides.style.files.length;
    const nicheCount = sides.niche.files.length;
    const vCount = variationsCount();
    const vLabel = $("#asVariationsLabel");

    sides.style.counter.textContent = `${styleCount} / 100`;
    sides.niche.counter.textContent = `${nicheCount} / 100`;

    if (mode === "fusion") {
      if (vLabel) vLabel.textContent = "Variations per niche";
      const totalOut = nicheCount * vCount;
      summary.textContent = styleCount > 0 && nicheCount > 0
        ? `${styleCount} style(s) fused across ${nicheCount} niche(s) · ${totalOut} variation(s) out`
        : "0 ready to generate";

      if (styleCount > 1 && nicheCount > 0) {
        warning.textContent = `Blending all ${styleCount} style references into a unified moodboard aesthetic for each niche.`;
        warning.classList.remove("hidden");
      } else {
        warning.textContent = "";
        warning.classList.add("hidden");
      }

      generateBtn.disabled = styleCount === 0 || nicheCount === 0;
    } else {
      if (vLabel) vLabel.textContent = "Variations per pair";
      const pairs = computePairs();
      summary.textContent = `${pairs} pair(s) in · ${pairs * vCount} variation(s) out`;

      if (styleCount === 1 && nicheCount > 1) {
        warning.textContent = `Applying 1 style reference across all ${nicheCount} niche references in parallel.`;
        warning.classList.remove("hidden");
      } else if (nicheCount === 1 && styleCount > 1) {
        warning.textContent = `Applying ${styleCount} style references to the 1 niche reference in parallel.`;
        warning.classList.remove("hidden");
      } else if (styleCount > 0 && nicheCount > 0 && styleCount !== nicheCount) {
        const extra = Math.abs(styleCount - nicheCount);
        warning.textContent = `${pairs} pair(s) paired 1-to-1 — ${extra} unpaired image(s) ignored.`;
        warning.classList.remove("hidden");
      } else {
        warning.textContent = "";
        warning.classList.add("hidden");
      }

      generateBtn.disabled = pairs === 0;
    }
  }

  const modeDescriptions = {
    fusion: "Fusion Mode: Combines all style images into a unified aesthetic moodboard. Gemini synthesizes textures, linework, and palettes into 1 hybrid style applied to your niche.",
    pairwise: "Pairwise Mode: Tests each style independently (1-to-1). Dispatches separate generations for each style reference so you can compare distinct aesthetics side-by-side."
  };

  const guidanceText = $("#asModeGuidanceText");
  const lblFusion = $("#lblModeFusion");
  const lblPairwise = $("#lblModePairwise");

  function setGuidance(modeKey) {
    if (guidanceText && modeDescriptions[modeKey]) {
      guidanceText.textContent = modeDescriptions[modeKey];
    }
  }

  if (lblFusion) {
    lblFusion.addEventListener("mouseenter", () => setGuidance("fusion"));
    lblFusion.addEventListener("mouseleave", () => setGuidance(getMode()));
  }
  if (lblPairwise) {
    lblPairwise.addEventListener("mouseenter", () => setGuidance("pairwise"));
    lblPairwise.addEventListener("mouseleave", () => setGuidance(getMode()));
  }

  document.querySelectorAll('input[name="asMode"]').forEach((el) => {
    el.addEventListener("change", () => {
      setGuidance(el.value);
    });
  });

  document.querySelectorAll('input[name="asMode"]').forEach((el) => {
    el.addEventListener("change", updatePairing);
  });
  variationsInput?.addEventListener("input", updatePairing);

  function renderSide(side) {
    if (side.files.length === 0) {
      side.thumbs.classList.add("hidden");
      side.thumbs.innerHTML = "";
    } else {
      side.thumbs.classList.remove("hidden");
      side.thumbs.innerHTML = side.files.map((file, idx) => `
        <div class="thumb-card" data-idx="${idx}">
          <img src="${URL.createObjectURL(file)}" alt="thumb" />
          <button type="button" class="thumb-del" data-del="${idx}" title="Remove"><i data-lucide="x"></i></button>
        </div>
      `).join("");
      renderIcons();
      side.thumbs.querySelectorAll(".thumb-del").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const delIdx = parseInt(btn.dataset.del, 10);
          side.files.splice(delIdx, 1);
          renderSide(side);
          updatePairing();
        });
      });
    }
  }

  function setupDrop(side) {
    const d = side.drop;
    const inp = side.input;

    bindDropAndPasteZone({
      dropzoneEl: d,
      inputEl: inp,
      onFileReceived: (files) => {
        if (files?.length) {
          const combined = [...side.files, ...Array.from(files)].slice(0, 100);
          side.files = combined;
          renderSide(side);
          updatePairing();
        }
      },
    });

    // Clicking or hovering anywhere in this column (dropzone, buttons, thumbs)
    // explicitly designates this slot as the active paste target
    const sideContainer = d.closest(".as-side");
    if (sideContainer) {
      sideContainer.addEventListener("mousedown", () => {
        setActiveDropzone(d);
      });
      sideContainer.addEventListener("mouseenter", () => {
        setActiveDropzone(d);
      });
    }

    d.addEventListener("click", () => {
      setActiveDropzone(d);
    });

    side.addMore.addEventListener("click", () => {
      setActiveDropzone(d);
      inp.click();
    });
    side.replace.addEventListener("click", () => {
      setActiveDropzone(d);
      side.files = [];
      inp.value = "";
      inp.click();
    });
    side.sideClearAll = side.drop.parentElement.querySelector('button[id$="ClearAll"]');
    if (side.sideClearAll) {
      side.sideClearAll.addEventListener("click", () => {
        setActiveDropzone(d);
        side.files = [];
        inp.value = "";
        renderSide(side);
        updatePairing();
      });
    }
  }

  setupDrop(sides.style);
  setupDrop(sides.niche);

  // Set style reference dropzone as initial active target
  setActiveDropzone(sides.style.drop);

  generateBtn.addEventListener("click", async () => {
    const mode = getMode();
    const styleCount = sides.style.files.length;
    const nicheCount = sides.niche.files.length;
    const vCount = variationsCount();

    if (styleCount === 0 || nicheCount === 0) return;
    const pairs = computePairs();
    if (mode === "pairwise" && pairs === 0) return;

    const totalTasks = mode === "fusion" ? (nicheCount * vCount) : (pairs * vCount);
    const totalUnits = mode === "fusion" ? nicheCount : pairs;

    abortController = new AbortController();
    generateBtn.disabled = true;
    stopBtn.classList.remove("hidden");
    stopBtn.disabled = false;
    progress.classList.remove("hidden");
    const labelEl = progress.querySelector("span");

    tracker = new GenerationProgressTracker({
      barEl: $("#asProgressFill"),
      labelEl,
      totalItems: totalUnits,
    });
    labelEl.textContent = mode === "fusion"
      ? `Fusing ${styleCount} styles into ${nicheCount} niche(s) in parallel...`
      : `Fusing style onto niche across ${pairs} pair(s) in parallel...`;
    if (typeof startAccountPoll === "function") startAccountPoll();

    const allDesigns = [];
    activeTotalSlots = totalTasks;

    // Guaranteed DOM reset: clears stale cards before inserting new placeholders
    $("#asResults").innerHTML = `
      <div class="results-head">
        <span>Results <span class="results-count" id="asOutCount">0 generated</span></span>
      </div>
      <div class="results-grid" id="asResultsGrid"></div>
    `;
    renderPlaceholders($("#asResultsGrid"), totalTasks, "as-slot");

    try {
      let nextUnitIdx = 0;
      const concurrency = Math.min(6, totalUnits);

      async function worker() {
        while (nextUnitIdx < totalUnits) {
          if (abortController.signal.aborted) break;
          const unitIdx = nextUnitIdx++;
          tracker.startItem(unitIdx);

          const fd = new FormData();
          if (mode === "fusion") {
            // Append ALL styles to build the collective moodboard
            sides.style.files.forEach((sf) => fd.append("style", sf));
            fd.append("niche", sides.niche.files[unitIdx]);
          } else {
            // Pairwise 1-to-1
            const styleFile = sides.style.files[unitIdx % styleCount];
            const nicheFile = sides.niche.files[unitIdx % nicheCount];
            fd.append("style", styleFile);
            fd.append("niche", nicheFile);
          }
          fd.append("count", vCount);
          fd.append("mode", mode);
          fd.append("aspectRatio", getAsShape());

          try {
            await fetchStreamNDJSON(
              "/api/generate/art-style-niche",
              { method: "POST", body: fd, signal: abortController.signal },
              (payload) => {
                if (payload.event === "design" && payload.design) {
                  const globalSlot = unitIdx * vCount + (payload.slotIndex || 0);
                  resolvePlaceholder(`as-slot-${globalSlot}`, payload.design);
                  allDesigns.push(payload.design);
                  $("#asOutCount").textContent = `${allDesigns.length} generated`;
                  if (typeof startAccountPoll === "function") startAccountPoll();
                } else if (payload.event === "slot_failed") {
                  const globalSlot = unitIdx * vCount + (payload.slotIndex || 0);
                  failPlaceholder(`as-slot-${globalSlot}`, payload.error || "Generation failed");
                } else if (payload.event === "error") {
                  console.error(`Unit ${unitIdx + 1} error:`, payload.error);
                }
              }
            );
          } catch (err) {
            if (err.name !== "AbortError") {
              console.error(`Unit ${unitIdx + 1} error:`, err);
              // Resolve orphaned placeholders to failed state immediately
              for (let s = 0; s < vCount; s++) {
                const globalSlot = unitIdx * vCount + s;
                failPlaceholder(`as-slot-${globalSlot}`, err.message || "Upload rejected");
              }
            }
          } finally {
            tracker.finishItem(unitIdx);
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      tracker.completeAll();
    } catch (err) {
      if (err.name !== "AbortError") {
        alert("Generation stopped or failed: " + err.message);
      }
    } finally {
      stopBtn.classList.add("hidden");
      stopBtn.disabled = true;
      abortController = null;
      progress.classList.add("hidden");
      updatePairing();
      if (typeof startAccountPoll === "function") startAccountPoll();
      refreshAccountsData();
    }
  });

  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;
    if (abortController) {
      try { abortController.abort(); } catch (_) {}
    }
    cancelAllPlaceholders($("#asResultsGrid") || $("#asResults"), "Cancelled");
    if (tracker && typeof tracker.stop === "function") {
      tracker.stop();
    }
    generateBtn.disabled = false;
  });
}


/* ── Design to Design View (Multi-Canvas Redraw) ─────────── */

function renderDesignToDesign() {
  let sourceFiles = [];
  let selectedBg = "transparent";
  let abortController = null;
  let magicStyle = null;
  // Hoisted so the Stop handler can mark every pending slot and stop the
  // progress engine without re-reading the DOM.
  let activeTotalSlots = 0;
  let tracker = null;

  // d2d's own palette — same pattern as Niche Variations' row, plus a pure
  // black (#000000) entry that is distinct from the existing dark-grey #111827.
  const D2D_BG_SWATCHES = [
    { label: "Transparent", value: "transparent", isTransparent: true },
    { label: "White", value: "#FFFFFF", color: "#FFFFFF" },
    { label: "Dark grey", value: "#111827", color: "#111827" },
    { label: "Black", value: "#000000", color: "#000000" },
    { label: "Cream", value: "#F5F0E6", color: "#F5F0E6" },
    { label: "Navy", value: "#1E3A8A", color: "#1E3A8A" },
    { label: "Forest", value: "#14532D", color: "#14532D" },
    { label: "Amber", value: "#D97706", color: "#D97706" },
  ];

  viewMount("d2d").innerHTML = `
    <div class="view">
      <header class="view-header">
        <div>
          <h1 class="page-title">Design to Design</h1>
          <p class="view-sub">Multi-canvas — upload up to 100 source designs and redraw each into a clean, print-ready version.</p>
        </div>
      </header>

      <div class="d2d-split-grid">
        <section class="d2d-panel d2d-card">
          <div class="stage-head">
            <span class="stage-title">Your designs</span>
            <span class="stage-counter" id="d2dCounter">0 / 100</span>
          </div>

          <div class="multi-dropzone" id="d2dDrop">
            <i data-lucide="upload-cloud"></i>
            <p><strong>Drop designs here or click to browse</strong></p>
            <p class="dropzone-hint">Gets a clean, print-ready redraw of each · or press <kbd>Ctrl</kbd> + <kbd>V</kbd> to paste</p>
            <input type="file" id="d2dFileInput" accept="image/*" multiple hidden />
          </div>

          <div class="stage-actions">
            <button type="button" class="btn secondary btn-sm" id="d2dAddMore"><i data-lucide="plus"></i> Add more</button>
            <button type="button" class="btn secondary btn-sm" id="d2dReplace"><i data-lucide="rotate-ccw"></i> Replace</button>
            <button type="button" class="btn secondary btn-sm" id="d2dClearAll" style="color: var(--color-danger, #ef4444);"><i data-lucide="trash-2"></i> Delete all</button>
          </div>

          <div class="thumbs-row hidden" id="d2dThumbs"></div>
        </section>

        <section class="d2d-panel">
          ${renderShapeSelector("d2d")}

          <div class="stage-head">
            <span class="stage-title">Background colour</span>
            <button type="button" class="btn secondary btn-sm" id="d2dResetBg"><i data-lucide="rotate-ccw"></i> Reset</button>
          </div>

          <div class="field">
            <div class="swatch-row" id="d2dSwatches">
              ${D2D_BG_SWATCHES.map((s) => `
                <button type="button" class="swatch ${s.isTransparent ? 'transparent active' : ''}"
                  data-val="${s.value}"
                  title="${s.label}"
                  aria-label="${s.label}"
                  style="${s.color ? `background-color: ${s.color};` : ''}">
                </button>
              `).join("")}
              <div class="swatch-custom" id="d2dCustomSwatch">
                <input type="color" id="d2dColorPicker" value="#ffffff" aria-label="Custom background colour" />
                <input type="text" id="d2dColorHex" value="#FFFFFF" spellcheck="false" aria-label="Custom background hex value" />
              </div>
            </div>
          </div>

          <div class="manual-style-field">
            <label class="manual-style-label" for="d2dManualStyle">Style (Optional — auto-pick or type/paste)</label>
            <div class="style-input-group">
              <input type="text" id="d2dManualStyle" class="manual-style-input" placeholder="e.g. Vintage Japanese Woodblock, Retro 70s, Cyberpunk..." />
              <button type="button" class="clear-style-btn" data-clear="d2dManualStyle">×</button>
            </div>
          </div>

          <div class="magic-style-container" id="d2dMagicStyle">
            <button type="button" class="magic-style-btn" id="d2dMagicBtn">${MAGIC_STYLE_BTN_DEFAULT}</button>
          </div>

          <div class="as-outputs-row">
            <label class="field as-outputs-field" for="d2dVariations">
              <span class="field-label">Variations per design</span>
              <input type="number" id="d2dVariations" min="1" max="100" value="1" />
            </label>
          </div>
        </section>
      </div>

      <div class="d2d-action-bar">
        <span class="d2d-action-summary" id="d2dSummary">0 designs in, 0 clean versions out</span>
        <div class="d2d-action-buttons">
          <button class="btn primary" id="d2dGenerate"><i data-lucide="sparkles"></i> Generate</button>
          <button class="btn secondary" id="d2dStop" disabled><i data-lucide="square"></i> Stop</button>
        </div>
      </div>

      <div class="progress-area hidden" id="d2dProgress">
        <p class="progress-line"><i data-lucide="refresh-cw"></i> <span>Starting…</span></p>
        <div class="progress-bar"><span class="progress-fill" id="d2dProgressFill" style="width:0%"></span></div>
      </div>

      <section class="d2d-results-section">
        <div class="results-head">
          <span>Saved to your library. <a class="text-link" id="d2dOpenLibrary" href="#">Open library</a></span>
          <span class="results-count" id="d2dOutCount">0 redrawn</span>
        </div>
        <div class="results-grid" id="d2dResults"></div>
      </section>

      <p class="note caution d2d-footer"><i data-lucide="alert-triangle"></i><span><strong>Caution — IP risk.</strong> This feature redraws existing designs into derivatives. Review each output for IP risk before uploading or listing it.</span></p>
    </div>`;

  renderIcons();

  const getD2dShape = bindShapeSelector("d2d");
  const dropzone = $("#d2dDrop");
  const fileInput = $("#d2dFileInput");
  const thumbsRow = $("#d2dThumbs");
  const counter = $("#d2dCounter");
  const summary = $("#d2dSummary");
  const generateBtn = $("#d2dGenerate");
  const stopBtn = $("#d2dStop");
  const progressLine = $("#d2dProgress");
  const variationsInput = $("#d2dVariations");

  function variationsCount() {
    return Math.min(100, Math.max(1, parseInt(variationsInput?.value, 10) || 1));
  }

  magicStyle = setupMagicStyle({
    btn: $("#d2dMagicBtn"),
    container: $("#d2dMagicStyle"),
    getContext: () => ({ prompt: "", imageFile: sourceFiles[0] || null }),
    onStyle: (name) => {
      const input = $("#d2dManualStyle");
      if (input) input.value = name;
    },
  });

  function updateSummary() {
    const n = sourceFiles.length;
    const vCount = variationsCount();
    counter.textContent = `${n} / 100`;
    summary.textContent = `${n} design${n === 1 ? "" : "s"} in, ${n * vCount} clean version${n * vCount === 1 ? "" : "s"} out`;
  }

  // Live tracker: changing the variations slot re-derives the output count.
  variationsInput?.addEventListener("input", updateSummary);

  function renderThumbs() {
    if (sourceFiles.length === 0) {
      thumbsRow.classList.add("hidden");
      thumbsRow.innerHTML = "";
    } else {
      thumbsRow.classList.remove("hidden");
      thumbsRow.innerHTML = sourceFiles.map((file, idx) => `
        <div class="thumb-card" data-idx="${idx}">
          <img src="${URL.createObjectURL(file)}" alt="thumb" />
          <button type="button" class="thumb-del" data-del="${idx}" title="Remove"><i data-lucide="x"></i></button>
        </div>
      `).join("");
      renderIcons();
    }
    updateSummary();
  }

  function addFiles(newFiles) {
    sourceFiles = [...sourceFiles, ...Array.from(newFiles)].slice(0, 100);
    renderThumbs();
  }

  bindDropAndPasteZone({
    dropzoneEl: dropzone,
    inputEl: fileInput,
    onFileReceived: addFiles,
  });

  $("#d2dAddMore").addEventListener("click", () => fileInput.click());
  $("#d2dClearAll")?.addEventListener("click", () => {
    sourceFiles = [];
    fileInput.value = "";
    renderThumbs();
  });
  $("#d2dReplace").addEventListener("click", () => {
    sourceFiles = [];
    fileInput.value = "";
    fileInput.click();
  });

  thumbsRow.addEventListener("click", (e) => {
    const delBtn = e.target.closest("[data-del]");
    if (!delBtn) return;
    const idx = parseInt(delBtn.dataset.del, 10);
    sourceFiles.splice(idx, 1);
    renderThumbs();
  });

  $$("#d2dSwatches .swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#d2dSwatches .swatch").forEach((b) => b.classList.remove("active"));
      $("#d2dCustomSwatch").classList.remove("active");
      btn.classList.add("active");
      selectedBg = btn.dataset.val;
    });
  });

  const d2dColorPicker = $("#d2dColorPicker");
  const d2dColorHex = $("#d2dColorHex");
  const d2dCustomSwatch = $("#d2dCustomSwatch");

  d2dColorPicker.addEventListener("input", (e) => {
    $$("#d2dSwatches .swatch").forEach((b) => b.classList.remove("active"));
    d2dCustomSwatch.classList.add("active");
    d2dColorHex.value = e.target.value.toUpperCase();
    selectedBg = e.target.value;
  });

  d2dColorHex.addEventListener("change", (e) => {
    let val = e.target.value.trim();
    if (!val.startsWith("#")) val = "#" + val;
    d2dColorPicker.value = val;
    d2dColorHex.value = val.toUpperCase();
    $$("#d2dSwatches .swatch").forEach((b) => b.classList.remove("active"));
    d2dCustomSwatch.classList.add("active");
    selectedBg = val;
  });

  // Reset clears back to transparent, which is the view's opening state.
  $("#d2dResetBg").addEventListener("click", () => {
    selectedBg = "transparent";
    $$("#d2dSwatches .swatch").forEach((b) => b.classList.remove("active"));
    d2dCustomSwatch.classList.remove("active");
    $("#d2dSwatches .swatch[data-val='transparent']")?.classList.add("active");
  });

  $("#d2dOpenLibrary").addEventListener("click", (e) => {
    e.preventDefault();
    showView("designs");
  });

  generateBtn.addEventListener("click", async () => {
    if (sourceFiles.length === 0) return alert("Upload at least one design to redraw.");
    const vCount = variationsCount();

    abortController = new AbortController();
    generateBtn.disabled = true;
    stopBtn.disabled = false;
    progressLine.classList.remove("hidden");
    const labelEl = progressLine.querySelector("span");
    // Continuous progress engine — one simulated curve per in-flight design,
    // aggregated across the batch. Replaces the old frozen 15% → 100% jump.
    tracker = new GenerationProgressTracker({
      barEl: $("#d2dProgressFill"),
      labelEl,
      totalItems: sourceFiles.length,
    });
    tracker.stop();
    labelEl.textContent = "Starting…";

    const allDesigns = [];
    // The section head (library link + count) is static markup now, so a run
    // only clears the grid and resets its counter.
    $("#d2dResults").innerHTML = "";
    $("#d2dOutCount").textContent = "0 redrawn";
    // Instant skeleton placeholders — one per expected output.
    const totalTasks = sourceFiles.length * vCount;
    activeTotalSlots = totalTasks;
    renderPlaceholders($("#d2dResults"), totalTasks, "d2d-slot");

    try {
      let completedCount = 0;
      let nextIdx = 0;
      const concurrency = Math.min(5, sourceFiles.length);

      async function worker() {
        while (nextIdx < sourceFiles.length) {
          if (abortController.signal.aborted) break;
          const loopIdx = nextIdx++;
          const file = sourceFiles[loopIdx];
          tracker.startItem(loopIdx);

          const fd = new FormData();
          fd.append("source", file);
          fd.append("bg_color", selectedBg);
          fd.append("aspectRatio", getD2dShape());
          fd.append("count", vCount);
          appendMagicStyle(fd, magicStyle.get());
          fd.append("manualStyle", ($("#d2dManualStyle")?.value || "").trim());

          try {
            // Stream each finished design back as it completes on the fleet.
            await fetchStreamNDJSON(
              "/api/generate/design-to-design",
              { method: "POST", body: fd, signal: abortController.signal },
              (payload) => {
                if (payload.event === "design" && payload.design) {
                  const globalSlot = loopIdx * vCount + (payload.slotIndex || 0);
                  resolvePlaceholder(`d2d-slot-${globalSlot}`, payload.design);
                  allDesigns.push(payload.design);
                  $("#d2dOutCount").textContent = `${allDesigns.length} redrawn`;
                } else if (payload.event === "slot_failed") {
                  const globalSlot = loopIdx * vCount + (payload.slotIndex || 0);
                  failPlaceholder(`d2d-slot-${globalSlot}`, payload.error || "Generation failed");
                } else if (payload.event === "error") {
                  console.error(`Design ${loopIdx + 1} error:`, payload.error);
                  for (let s = 0; s < vCount; s++) {
                    failPlaceholder(`d2d-slot-${loopIdx * vCount + s}`, payload.error || "Failed");
                  }
                }
              }
            );
          } catch (err) {
            console.error(`Design ${loopIdx + 1} failed:`, err);
            for (let s = 0; s < vCount; s++) {
              failPlaceholder(`d2d-slot-${loopIdx * vCount + s}`, err.name === "AbortError" ? "Cancelled" : (err.message || "Failed"));
            }
          } finally {
            completedCount++;
            tracker.finishItem(loopIdx);
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      tracker.completeAll();
    } catch (err) {
      if (err.name !== "AbortError") {
        alert("Redraw process stopped or failed: " + err.message);
      }
      cancelAllPlaceholders($("#d2dResults"), err.name === "AbortError" ? "Cancelled" : (err.message || "Failed"));
    } finally {
      generateBtn.disabled = false;
      stopBtn.disabled = true;
      setTimeout(() => { if (!abortController) progressLine.classList.add("hidden"); }, 2500);
      abortController = null;
      refreshAccountsData();
    }
  });

  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;

    // 1. Instantly abort local fetch stream
    if (abortController) {
      try { abortController.abort(); } catch (_) { }
    }

    // 2. Instantly cancel all placeholders currently present in the DOM
    cancelAllPlaceholders($("#d2dResults"), "Cancelled");

    // 3. Instantly stop progress animation & restore generate button
    if (tracker && typeof tracker.stop === "function") {
      tracker.stop();
    }
    generateBtn.disabled = false;

    const progressLabel = progressLine.querySelector("span");
    if (progressLabel) {
      progressLabel.textContent = "Generation stopped";
    }

    // 4. Fire-and-forget backend cancel beacon (DO NOT await before UI update)
    fetch("/api/generate/cancel", { method: "POST" })
      .catch((err) => console.warn("Cancel signal delivery failed:", err))
      .finally(() => {
        if (typeof startAccountPoll === "function") {
          startAccountPoll();
        }
      });
  });
}

/* ── Result Card Template ────────────────────────────────── */

function resultCard(d) {
  const label = (d.feature || "design").replace(/-/g, " ");
  const timeBadge = d.generation_time ? `
    <span class="timer-pill" title="Generated in ${esc(d.generation_time)}" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#38bdf8;background:rgba(56,189,248,0.12);padding:2px 8px;border-radius:9999px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
      <i data-lucide="timer" style="width:12px;height:12px;"></i> ${esc(d.generation_time)}
    </span>` : "";

  const compressBadge = d.compression ? (() => {
    const orig = d.compression.beforeBytes ?? d.compression.originalBytes;
    const comp = d.compression.afterBytes ?? d.compression.compressedBytes;
    const saved = d.compression.savedPercent ?? d.compression.savedPct ?? (orig && comp ? Math.max(0, Math.round((1 - comp / orig) * 100)) : 0);
    const formatBytes = (b) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
    const badgeText = d.compression.badge || (orig && comp ? `${formatBytes(orig)} → ${formatBytes(comp)} (-${saved}%)` : null);
    if (!badgeText) return "";
    return `
      <span class="prep-compression-badge" title="Original: ${esc(orig)} bytes → Compressed: ${esc(comp)} bytes (-${esc(saved)}%)">
        <i data-lucide="archive" style="width:12px;height:12px;"></i> ${esc(badgeText)}
      </span>`;
  })() : "";

  return `
    <div class="result-card panel" data-id="${esc(d.id)}">
      <div class="image-mount"><img src="/library/${esc(d.output_image_path)}" alt="" loading="lazy" /></div>
      <div class="result-caption" title="${esc(d.user_input || "")}">${esc(d.user_input || label)}</div>
      ${compressBadge ? `<div style="padding: 0 0.5rem 0.25rem;">${compressBadge}</div>` : ""}
      <div class="result-meta" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
        <span>${esc(label)} · ${esc((d.created_at || "").slice(0, 16))}</span>
        <div style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">
          ${timeBadge}
          ${d.account_email ? `<span class="account-pill" title="Generated by ${esc(d.account_email)}" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#10b981;background:rgba(16,185,129,0.12);padding:2px 8px;border-radius:9999px;font-weight:500;"><i data-lucide="check-circle-2" style="width:12px;height:12px;"></i> ${esc(d.account_email.split('@')[0])}</span>` : ""}
        </div>
      </div>
      <div class="result-actions-row">
        <a class="save-toggle" href="/library/${esc(d.output_image_path)}" download="${esc(d.id)}.png">
          <i data-lucide="download"></i> Save
        </a>
      </div>
    </div>`;
}

function setupDropzone({ drop, input }) {
  const promptEl = drop.querySelector(".dropzone-prompt");
  const previewEl = drop.querySelector(".dropzone-preview");

  function setFile(file) {
    if (!file) return;
    previewEl.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="preview" />`;
    previewEl.classList.remove("hidden");
    promptEl.classList.add("hidden");
    drop.classList.add("has-file");
  }

  input.addEventListener("change", () => setFile(input.files[0]));
  drop.addEventListener("click", (e) => {
    if (e.target !== input) input.click();
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    if (e.dataTransfer.files.length) {
      input.files = e.dataTransfer.files;
      setFile(e.dataTransfer.files[0]);
    }
  });
}

/* ── Gemini Accounts View ────────────────────────────────── */

// Legacy fallback: usage_daily/usage_weekly are best-effort TEXT readouts
// ("42%", "42/100", a bare number) or null. Structured usage objects from
// /api/accounts/usage take precedence; this only parses the old string shape.
function usagePct(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Math.max(0, Math.min(100, value));
  const str = String(value).trim();
  const pct = str.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return Math.max(0, Math.min(100, parseFloat(pct[1])));
  const frac = str.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const denom = parseFloat(frac[2]);
    return denom > 0 ? Math.max(0, Math.min(100, (parseFloat(frac[1]) / denom) * 100)) : null;
  }
  const num = parseFloat(str);
  return Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : null;
}

// Countdown to a reset moment (ISO) — "in 6h 12m", "in 2d 3h", "in <1m".
function untilLabel(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return `in ${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

function getAppTimezone() {
  return localStorage.getItem("app_timezone") || "Africa/Casablanca-gmt0";
}

function resolveAppTz(tz) {
  if (!tz || tz === "auto") return undefined;
  if (tz === "Africa/Casablanca-gmt0") return "UTC";
  if (tz === "Africa/Casablanca-gmt1") return "Etc/GMT-1";
  return tz;
}

function formatAppTime(dateOrIso, options = {}) {
  if (!dateOrIso) return "";
  const d = typeof dateOrIso === "string" ? new Date(dateOrIso) : dateOrIso;
  if (Number.isNaN(d.getTime())) return "";
  const tz = resolveAppTz(getAppTimezone());
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz, ...options });
}

function formatAppDate(dateOrIso, options = {}) {
  if (!dateOrIso) return "";
  const d = typeof dateOrIso === "string" ? new Date(dateOrIso) : dateOrIso;
  if (Number.isNaN(d.getTime())) return "";
  const tz = resolveAppTz(getAppTimezone());
  return d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: tz, ...options });
}

function usageWhen(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  const time = formatAppTime(d);

  const now = new Date();
  const tz = resolveAppTz(getAppTimezone());
  const fmt = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

  const todayStr = fmt(now);
  const itemStr = fmt(d);
  if (todayStr === itemStr) return time;

  const yesterday = new Date(now.getTime() - 86400000);
  if (fmt(yesterday) === itemStr) return `Yesterday ${time}`;

  return `${formatAppDate(d)}, ${time}`;
}

// One meter row. `u` is the structured {count, cap, pct} object; fallbackValue
// is the legacy TEXT readout for rows that have none yet. The fill shifts to
// amber at 70% and red at 90% so a hot account is visible at a glance.
function usageRow(label, u, fallbackValue) {
  const pct = u ? u.pct : usagePct(fallbackValue);
  const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const level = pct == null ? "" : pct >= 90 ? " crit" : pct >= 70 ? " warn" : "";
  const display = pct == null ? "—" : `${Math.round(pct)}%`;
  return `
      <div class="usage-row">
        <span class="usage-label">${label}</span>
        <span class="usage-track"><span class="usage-fill${level}" style="width:${width}%"></span></span>
        <span class="usage-pct">${display}</span>
      </div>`;
}

// Inline brand glyphs. Lucide 1.x dropped every brand icon — 'chrome' no
// longer exists in the bundle (the old <i data-lucide="chrome"> silently
// rendered nothing), and no Google mark was ever shipped — so the Chrome and
// Google glyphs are inlined here. Both stay monochrome via currentColor to
// match the v2 icon treatment, and the Chrome one restores the exact geometry
// of the original Lucide 'chrome' icon.
const CHROME_GLYPH = `
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle>
    <line x1="21.17" y1="8" x2="12" y2="8"></line><line x1="3.95" y1="6.06" x2="8.54" y2="14"></line><line x1="10.88" y1="21.94" x2="15.46" y2="14"></line>
  </svg>`;

const GOOGLE_GLYPH = `
  <svg viewBox="0 0 18 18" width="24" height="24" fill="currentColor" aria-hidden="true">
    <path d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"></path>
    <path d="M9 18c2.43 0 4.4673-.806 5.9564-2.1818l-2.9087-2.2581c-.8059.54-1.8369.859-3.0477.859-2.344 0-4.3282-1.5831-5.036-3.7104H.9574v2.3318C2.4382 15.9832 5.4818 18 9 18z"></path>
    <path d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.964 10.71z"></path>
    <path d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.6559 3.5795 9 3.5795z"></path>
  </svg>`;

function accountCard(acc, best) {
  const label = (acc.email && acc.email.trim()) || "Google account";
  const isRunning = acc.status === "generating";
  const badgeCls = isRunning ? "checking" : acc.status === "ready" ? "ready" : "error";
  const statusLabel = isRunning ? "Running" : acc.status === "ready" ? "Ready" : acc.status;
  const profileLabel = acc.browser === "brave" ? "Brave profile" : acc.browser === "google" ? "Google profile" : "Chrome profile";
  const isBest = best && acc.id === best.id;

  // Structured usage from /api/accounts/usage (count/cap/pct/reset/last-used);
  // the legacy TEXT readouts are the fallback until the payload exists.
  const u = acc.usage || null;
  const daily = u ? u.daily : null;
  const weekly = u ? u.weekly : null;
  const lifetime = u ? u.totalGenerations : acc.generation_count ?? 0;
  const lastUsed = usageWhen(u ? u.lastUsedAt : acc.last_used_at ? `${acc.last_used_at.replace(" ", "T")}Z` : null);

  const dailyLine = daily
    ? `Daily ${daily.count}/${daily.cap} · resets at midnight (${esc(untilLabel(daily.resetsAt))})`
    : "Daily resets at midnight (local time)";
  const weeklyLine = weekly
    ? `Weekly ${weekly.count}/${weekly.cap} · resets Monday 00:00 (${esc(untilLabel(weekly.resetsAt))})`
    : "Weekly resets Monday 00:00 (local time)";

  return `
    <div class="card panel account-card${isBest ? " is-best" : ""}" data-id="${esc(acc.id)}">
      <div class="account-head">
        <span class="status-dot ${badgeCls}"></span>
        <span class="status-badge ${badgeCls}">${esc(statusLabel)}</span>
        <span class="account-gmail" title="${esc(acc.email || '')}">${esc(label)}</span>
        ${isBest ? `<span class="best-chip" title="${esc(best.reason)}"><i data-lucide="award"></i> Best</span>` : ""}
        <div class="account-actions">
            <button class="icon-btn" title="Sign In / Reconnect" data-act="login"><i data-lucide="log-in"></i></button>
          <button class="icon-btn" title="Check session" data-act="check"><i data-lucide="refresh-cw"></i></button>
          <button class="icon-btn danger" title="Remove account" data-act="remove"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <p class="account-meta" title="Session last checked: ${esc(acc.last_checked_at || "never")}">${esc(profileLabel)} · Last used: ${esc(lastUsed)}</p>
      <div class="usage-block">
        <div class="usage-head">
          <span>Current usage</span>
          <span class="info-tip" tabindex="0" data-tip="Self-tracked by this app — every successful generation counts against this account's daily and weekly caps (not a live Google quota pull). Daily resets at midnight, weekly at Monday 00:00, both local time. Generation is routed to the ready account with the most quota headroom.">
            <i data-lucide="info"></i>
          </span>
        </div>
        ${usageRow("Daily", daily, acc.usage_daily)}
        ${usageRow("Weekly", weekly, acc.usage_weekly)}
        <p class="usage-reset">${dailyLine}</p>
        <p class="usage-reset">${weeklyLine}</p>
        <p class="usage-reset">Lifetime: ${lifetime} generation${lifetime === 1 ? "" : "s"}</p>
      </div>
    </div>`;
}

// Fleet strip cell — the linked view of all accounts' data.
function fleetCell(icon, value, sub, label) {
  return `
    <div class="card panel stat-card fleet-cell">
      <div class="stat-icon"><i data-lucide="${icon}"></i></div>
      <div class="stat-value">${value}<span class="fleet-sub">${sub}</span></div>
      <div class="stat-label">${label}</div>
    </div>`;
}

let accountsPoll = null;
let lastAccountsJson = null;

async function renderAccounts() {
  // Any re-render supersedes the previous poll cycle.
  if (accountsPoll) {
    clearInterval(accountsPoll);
    accountsPoll = null;
  }

  let data = null;
  try {
    data = await api(`/api/accounts/usage?tz=${encodeURIComponent(getAppTimezone())}`);
  } catch (err) {
    viewMount("accounts").innerHTML = `
      <div class="view">
        <header class="view-header"><div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;width:100%;">
          <h1 class="page-title" style="margin:0;">Gemini Accounts</h1>
          <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.06);padding:6px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);">
            <i data-lucide="globe" style="width:16px;height:16px;opacity:0.8;"></i>
            <select id="tzSelector" style="background:transparent;border:none;color:#fff;font-size:12px;font-weight:500;outline:none;cursor:pointer;">
              <option value="Africa/Casablanca-gmt0" style="background:#1a1c23;color:#fff;">🇲🇦 Morocco (GMT+0 Standard)</option>
              <option value="Africa/Casablanca-gmt1" style="background:#1a1c23;color:#fff;">🇲🇦 Morocco (GMT+1 Summer)</option>
              <option value="auto" style="background:#1a1c23;color:#fff;">🌐 Auto (Browser System)</option>
              <option value="UTC" style="background:#1a1c23;color:#fff;">⏱️ UTC / GMT</option>
              <option value="America/New_York" style="background:#1a1c23;color:#fff;">🇺🇸 US Eastern (New York, Toronto)</option>
              <option value="America/Chicago" style="background:#1a1c23;color:#fff;">🇺🇸 US Central (Chicago)</option>
              <option value="America/Denver" style="background:#1a1c23;color:#fff;">🇺🇸 US Mountain (Denver)</option>
              <option value="America/Los_Angeles" style="background:#1a1c23;color:#fff;">🇺🇸 US Pacific (California, Vancouver)</option>
              <option value="Europe/London" style="background:#1a1c23;color:#fff;">🇬🇧 London (GMT / BST)</option>
              <option value="Europe/Paris" style="background:#1a1c23;color:#fff;">🇫🇷 Paris / Berlin (CET)</option>
              <option value="Asia/Dubai" style="background:#1a1c23;color:#fff;">🇦🇪 Gulf / Dubai (GST)</option>
            </select>
          </div>
        </div></header>
        <div class="empty"><i data-lucide="users"></i><p class="empty-title">Could not reach the server</p></div>
      </div>`;
    renderIcons();
    return;
  }

  const accounts = data.accounts || [];
  const fleet = data.fleet || {};
  const best = data.best || null;
  const caps = data.caps || {};
  setTimeout(() => {
    const sel = document.getElementById("tzSelector");
    if (sel) {
      sel.value = getAppTimezone();
      sel.onchange = (e) => {
        localStorage.setItem("app_timezone", e.target.value);
        renderAccounts();
      };
    }
  }, 10);
  lastAccountsJson = JSON.stringify(data);

  // Best account first — the recommendation leads the grid, and its card
  // carries the chip. /usage returns the meters as a top-level map keyed by
  // account id; hydrate each row so the card renders from structured data.
  const usageMap = data.usage || {};
  const ordered = (best
    ? [...accounts].sort((a, b) => (a.id === best.id ? -1 : b.id === best.id ? 1 : 0))
    : accounts
  ).map((a) => ({ ...a, usage: usageMap[a.id] ?? null }));

  const fleetDailyCap = (caps.daily || 0) * accounts.length;
  const fleetWeeklyCap = (caps.weekly || 0) * accounts.length;

  viewMount("accounts").innerHTML = `
    <div class="view">
      <header class="view-header">
        <h1 class="page-title">Gemini Accounts</h1>
        <div class="view-actions">
          <button class="btn secondary" id="checkAllBtn"><i data-lucide="refresh-cw"></i> Check all</button>
        </div>
      </header>
      <p class="note">Each account is its own hidden browser profile, signed in once. Your everyday browsing stays untouched.</p>
      <div class="cards-grid fleet-strip">
        ${fleetCell(
    "calendar-clock",
    fleet.generationsToday ?? 0,
    fleetDailyCap ? ` / ${fleetDailyCap}` : "",
    `Today · all accounts · ${Math.round(fleet.dailyPct ?? 0)}% of fleet cap · resets midnight (${esc(untilLabel(fleet.resetDailyAt))})`
  )}
        ${fleetCell(
    "calendar-range",
    fleet.generationsWeek ?? 0,
    fleetWeeklyCap ? ` / ${fleetWeeklyCap}` : "",
    `This week · all accounts · ${Math.round(fleet.weeklyPct ?? 0)}% of fleet cap · resets Monday 00:00 (${esc(untilLabel(fleet.resetWeeklyAt))})`
  )}
        <div class="card panel stat-card fleet-cell best-cell">
          <div class="stat-icon"><i data-lucide="award"></i></div>
          <div class="stat-value best-value">${best ? esc(best.email || "Ready account") : "—"}</div>
          <div class="stat-label">${best ? esc(best.reason) : "No ready account to recommend yet"}</div>
        </div>
      </div>
      <div class="cards-grid" id="accountGrid">
        ${ordered.map((a) => accountCard(a, best)).join("")}
        <div class="card panel account-card" id="addCard">
          <div class="account-head">
            <span class="add-glyph" aria-hidden="true">${GOOGLE_GLYPH}</span>
            <span class="status-text">Add an account</span>
          </div>
          <p class="note">Opens a fresh browser window — sign in once and it closes automatically.</p>
          <div class="view-actions" style="margin-top:12px">
            <button class="btn secondary" data-add="chrome">${CHROME_GLYPH} Chrome</button>
            <button class="btn secondary" data-add="brave"><i data-lucide="shield"></i> Brave</button>
            <button class="btn secondary" data-add="google">${GOOGLE_GLYPH} Google</button>
          </div>
        </div>
      </div>
    </div>`;
  renderIcons();

  // Link the data going forward: poll while the view is open and re-render only
  // when something actually changed (a generation, a status flip, a reset).
  accountsPoll = setInterval(async () => {
    const section = document.getElementById("section-accounts");
    if (!section || section.classList.contains("hidden")) return; // not visible — skip
    if (!document.querySelector("#accountGrid")) {
      clearInterval(accountsPoll);
      accountsPoll = null;
      return;
    }
    try {
      const fresh = await api(`/api/accounts/usage?tz=${encodeURIComponent(getAppTimezone())}`);
      if (JSON.stringify(fresh) !== lastAccountsJson) renderAccounts();
    } catch {
      /* keep showing the last good payload */
    }
  }, 15000);

  $("#accountGrid").addEventListener("click", async (e) => {
    const add = e.target.closest("[data-add]");
    if (add) return startAddAccount(add.dataset.add);
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const card = btn.closest(".account-card");
    try {
      if (btn.dataset.act === "login") {
        btn.disabled = true;
        btn.classList.add("spinning");
        await api(`/api/accounts/${card.dataset.id}/login`, { method: "POST" });
      } else if (btn.dataset.act === "check") {
        btn.disabled = true;
        btn.classList.add("spinning");
        await api(`/api/accounts/${card.dataset.id}/check`, { method: "POST" });
      } else if (btn.dataset.act === "remove") {
        if (!confirm("Remove this account? Past designs stay safe.")) return;
        await api(`/api/accounts/${card.dataset.id}`, { method: "DELETE" });
      }
      await renderAccounts();
      refreshTopBar();
    } catch (err) {
      alert("Action failed: " + err.message);
    }
  });

  $("#checkAllBtn").addEventListener("click", async () => {
    await api("/api/accounts/check-all", { method: "POST" });
    await renderAccounts();
    refreshTopBar();
  });
}

async function startAddAccount(browser) {
  try {
    alert(`Opening ${browser} window. Sign into your Google account and wait for the window to close.`);
    await api("/api/accounts", { method: "POST", body: JSON.stringify({ browser }) });
    await renderAccounts();
    refreshTopBar();
  } catch (err) {
    alert("Sign-in failed: " + err.message);
  }
}

/* ── My Designs Library View (UI-UX Pro Max) ─────────────── */

const libraryState = { folder: "", feature: "", page: 1, total: 0 };
const designById = new Map();
let isSelectMode = false;
const selectedDesignIds = new Set();

function designCard(d) {
  const isSelected = selectedDesignIds.has(d.id);
  const label = (d.feature || "design").replace(/-/g, " ");
  const cleanTitle = d.user_input && d.user_input !== d.feature ? d.user_input : label;
  const dateStr = d.created_at ? new Date(d.created_at).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

  // Suggested download filename: slug of the card title, feature-name
  // fallback, "design" as the last resort. Strict [a-z0-9-] charset keeps it
  // attribute-safe and filesystem-safe on Windows/macOS.
  const ext = (String(d.output_image_path).match(/\.(\w{2,5})$/) || [null, "png"])[1].toLowerCase();
  const fileBase = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "design";

  return `
    <div class="result-card panel design-card ${isSelected ? 'selected' : ''}" data-id="${esc(d.id)}">
      <div class="image-mount design-mount">
        <img src="/library/${esc(d.output_image_path)}" alt="" loading="lazy" />
        <span class="folder-chip">${esc(d.folder || "Unsorted")}</span>
        <div class="select-indicator"><i data-lucide="check"></i></div>
        <div class="hover-actions">
          <button type="button" class="pill-btn" data-act="expand" title="Expand"><i data-lucide="maximize-2"></i></button>
          <button type="button" class="pill-btn" data-act="edit" title="Edit"><i data-lucide="pencil"></i></button>
          <button type="button" class="pill-btn" data-act="move" title="Move to folder"><i data-lucide="folder-input"></i></button>
          <button type="button" class="pill-btn" data-act="open" title="Open original"><i data-lucide="external-link"></i></button>
          <button type="button" class="pill-btn danger" data-act="delete" title="Delete"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <div class="result-caption" title="${esc(cleanTitle)}">${esc(cleanTitle)}</div>
      <div class="result-meta">${esc(label)} · ${esc(dateStr)}</div>
      <div class="result-actions-row">
        <a class="save-toggle" href="/library/${esc(d.output_image_path)}" download="${esc(fileBase)}.${ext}">
          <i data-lucide="download"></i> Save
        </a>
      </div>
    </div>`;
}

/* ── Batch "Save all" export ────────────────────────────────
   Writes the loaded designs into a folder the user picks. On Chromium the
   File System Access API drives the native OS folder dialog (Windows File
   Explorer / macOS Finder); browsers without it fall back to one sequential
   download per design. */

// Keeps the button's label in sync with the current batch selection: with
// nothing checked, the button exports everything loaded in the view.
function updateBatchSaveLabel() {
  const label = $("#batchSaveLabel");
  if (!label) return;
  const n = selectedDesignIds.size;
  label.textContent = n > 0 ? `Save selected (${n})` : "Save all";
}

// "design name_abc123.png" — slug from the prompt/feature, plus the id so two
// designs with the same title never collide. Strict charset keeps it safe on
// Windows and macOS.
function designFileName(d) {
  const raw = (d.user_input && d.user_input !== d.feature ? d.user_input : d.feature) || "design";
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "design";
  const id = String(d.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "img";
  const ext = (String(d.output_image_path).match(/\.(\w{2,5})$/) || [null, "png"])[1].toLowerCase();
  return `${slug}_${id}.${ext}`;
}

function designImageUrl(d) {
  return `/library/${String(d.output_image_path).split("/").map(encodeURIComponent).join("/")}`;
}

async function fetchDesignBlob(d) {
  const res = await fetch(designImageUrl(d));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.blob();
}

async function saveDesignsBatch(btn) {
  // Checked designs win; with none checked, export everything in the view.
  const targets = selectedDesignIds.size > 0
    ? [...designById.values()].filter((d) => selectedDesignIds.has(d.id))
    : [...designById.values()];

  if (targets.length === 0) {
    alert("No designs to save.");
    return;
  }

  const setLabel = (text) => {
    const label = $("#batchSaveLabel");
    if (label) label.textContent = text;
  };
  const finish = () => {
    btn.disabled = false;
    updateBatchSaveLabel();
  };

  // Bundle every checked design into ONE zip on the server (archiver streams
  // it straight to the browser), then trigger a single download link so the
  // OS save dialog opens exactly once.
  btn.disabled = true;
  setLabel("Zipping...");
  try {
    const res = await fetch("/api/designs/export-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: targets.map((d) => d.id) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const stamp = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `designs_export_${stamp}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setLabel("Saved!");
    setTimeout(finish, 1500);
  } catch (err) {
    console.error("Zip export failed:", err);
    finish();
    alert("Could not create the zip: " + (err.message || err));
  }
}

async function renderDesigns() {
  const query = new URLSearchParams({
    ...(libraryState.folder ? { folder: libraryState.folder } : {}),
    ...(libraryState.feature ? { feature: libraryState.feature } : {}),
    page: libraryState.page,
    pageSize: 1000,
  });

  let data = { rows: [], total: 0, page: 1 };
  try {
    data = await api(`/api/designs?${query}`);
  } catch (err) {
    console.error("Failed to load designs:", err);
  }

  libraryState.total = data.total || 0;
  libraryState.page = data.page || 1;
  designById.clear();
  (data.rows || []).forEach((d) => designById.set(d.id, d));

  // Extract unique folders for the filter
  const allFolders = [...new Set((data.rows || []).map((r) => r.folder).filter(Boolean))];

  viewMount("designs").innerHTML = `
    <div class="view">
      <div class="library-toolbar">
        <header class="view-header" style="margin-bottom:0;">
          <h1 class="page-title">My Designs <span class="results-count" style="font-size:14px; margin-left:8px;">${libraryState.total}</span></h1>
        </header>

        <div class="lib-filters">
          <select id="libFolderFilter">
            <option value="">All folders</option>
            ${allFolders.map((f) => `<option value="${esc(f)}" ${libraryState.folder === f ? 'selected' : ''}>${esc(f)}</option>`).join("")}
          </select>

          <select id="libFeatureFilter">
            <option value="">All features</option>
            <option value="text-to-image" ${libraryState.feature === 'text-to-image' ? 'selected' : ''}>Text to Image</option>
            <option value="niche-variations" ${libraryState.feature === 'niche-variations' ? 'selected' : ''}>Niche Variations</option>
            <option value="design-to-design" ${libraryState.feature === 'design-to-design' ? 'selected' : ''}>Design to Design</option>
            <option value="art-style-niche" ${libraryState.feature === 'art-style-niche' ? 'selected' : ''}>Art Style + Niche</option>
          </select>

          <button class="btn secondary btn-sm" id="libSelectBtn">
            <i data-lucide="${isSelectMode ? 'x' : 'check-square'}"></i> ${isSelectMode ? 'Cancel' : 'Select'}
          </button>
          <button class="icon-btn" id="libRefreshBtn" title="Refresh library"><i data-lucide="refresh-cw"></i></button>
        </div>
      </div>

      <div class="batch-bar ${isSelectMode ? '' : 'hidden'}" id="batchBar">
        <div class="batch-info"><span id="batchCount">${selectedDesignIds.size}</span> item(s) selected</div>
        <div class="batch-actions">
          <button class="btn secondary btn-sm" id="batchSelectAll">Select all</button>
          <button class="btn secondary btn-sm" id="batchSaveBtn"><i data-lucide="folder-down"></i> <span id="batchSaveLabel">Save all</span></button>
          <button class="btn secondary btn-sm" id="batchDeselectAll">Deselect all</button>
          <button class="btn primary btn-sm danger" id="batchDeleteBtn" style="background:#EF4444;" ${selectedDesignIds.size === 0 ? 'disabled' : ''}>
            <i data-lucide="trash-2"></i> Delete selected
          </button>
        </div>
      </div>

      <div class="results-grid library-grid ${isSelectMode ? 'selecting' : ''}" id="libraryGrid">
        ${(data.rows || []).map(designCard).join("")}
      </div>
    </div>`;

  renderIcons();
  updateBatchSaveLabel();

  // Filter Listeners
  $("#libFolderFilter").addEventListener("change", (e) => {
    libraryState.folder = e.target.value;
    renderDesigns();
  });

  $("#libFeatureFilter").addEventListener("change", (e) => {
    libraryState.feature = e.target.value;
    renderDesigns();
  });

  $("#libRefreshBtn").addEventListener("click", () => renderDesigns());

  // Toggle Batch Selection
  $("#libSelectBtn").addEventListener("click", () => {
    isSelectMode = !isSelectMode;
    if (!isSelectMode) selectedDesignIds.clear();
    renderDesigns();
  });

  // Batch Bar Actions
  $("#batchSelectAll")?.addEventListener("click", () => {
    designById.forEach((_, id) => selectedDesignIds.add(id));
    renderDesigns();
  });

  $("#batchDeselectAll")?.addEventListener("click", () => {
    selectedDesignIds.clear();
    renderDesigns();
  });

  $("#batchSaveBtn")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    saveDesignsBatch(btn);
  });

  $("#batchDeleteBtn")?.addEventListener("click", async () => {
    if (selectedDesignIds.size === 0) return;
    if (!confirm(`Permanently delete ${selectedDesignIds.size} design(s)?`)) return;

    for (const id of selectedDesignIds) {
      await api(`/api/designs/${id}`, { method: "DELETE" }).catch(() => { });
    }
    selectedDesignIds.clear();
    isSelectMode = false;
    await renderDesigns();
  });

  // Grid Click Handler
  $("#libraryGrid").addEventListener("click", async (e) => {
    const card = e.target.closest(".design-card");
    if (!card) return;
    const id = card.dataset.id;
    const design = designById.get(id);

    // In batch selection mode, clicking card toggles selection
    if (isSelectMode) {
      if (selectedDesignIds.has(id)) {
        selectedDesignIds.delete(id);
      } else {
        selectedDesignIds.add(id);
      }
      card.classList.toggle("selected", selectedDesignIds.has(id));
      const badge = $("#batchCount");
      if (badge) badge.textContent = selectedDesignIds.size;
      const delBtn = $("#batchDeleteBtn");
      if (delBtn) delBtn.disabled = selectedDesignIds.size === 0;
      updateBatchSaveLabel();
      return;
    }

    // Normal Mode: Hover Pill Actions
    const btn = e.target.closest("[data-act]");
    if (!btn || !design) return;

    const act = btn.dataset.act;
    if (act === "expand") {
      openExpandModal(design);
    } else if (act === "edit") {
      openEditModal(design);
    } else if (act === "move") {
      openMoveModal(design);
    } else if (act === "open") {
      window.open(`/library/${design.output_image_path}`, "_blank");
    } else if (act === "delete") {
      if (confirm("Delete this design from library?")) {
        await api(`/api/designs/${id}`, { method: "DELETE" });
        await renderDesigns();
      }
    }
  });
}

/* ── UI-UX Pro Max Modal Controllers ─────────────────────── */

const FEATURE_LABELS = {
  "text-to-image": "Text to Image",
  "niche-variations": "Niche Variations",
  "design-to-design": "Design to Design",
  "pixel-to-pixel": "Pixel to Pixel",
  "art-style-niche": "Art Style + Niche",
};

// SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC with no marker, so
// it has to be tagged before parsing or the browser reads it as local time.
function formatDesignDate(value) {
  if (!value) return "";
  const sqlite = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/.exec(value);
  const parsed = sqlite
    ? new Date(`${sqlite[1]}T${sqlite[2]}${sqlite[3] || ":00"}Z`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).slice(0, 16);
  return parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

// navigator.clipboard is undefined outside a secure context, which is how the
// studio is often opened (http:// on a LAN IP), so keep a legacy path.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// These copy controls are icon-only, so the accessible name has to carry the
// meaning and the confirmation — the icon swap alone says nothing to a screen
// reader. Reverts after a beat.
async function copyWithFeedback(btn, text, label) {
  if (!btn || !text) return;
  const ok = await copyToClipboard(text);
  btn.innerHTML = `<i data-lucide="${ok ? "check" : "x"}"></i>`;
  btn.classList.toggle("copied", ok);
  btn.setAttribute("aria-label", ok ? `${label} copied` : `Could not copy ${label}`);
  btn.title = ok ? "Copied" : "Copy failed";
  renderIcons();

  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.innerHTML = `<i data-lucide="copy"></i>`;
    btn.classList.remove("copied");
    btn.setAttribute("aria-label", `Copy ${label}`);
    btn.title = `Copy ${label}`;
    renderIcons();
  }, 1400);
}

function metaItem(label, valueHtml) {
  return `<div class="meta-item">
      <span class="meta-label">${esc(label)}</span>
      <span class="meta-value">${valueHtml}</span>
    </div>`;
}

// Guards against a slow image landing after the user has already opened a
// different design, which would otherwise print the wrong dimensions.
let expandLoadToken = 0;

function openExpandModal(d) {
  const m = $("#expandModal");
  if (!m) return;

  const featureLabel = FEATURE_LABELS[d.feature] || (d.feature || "design").replace(/-/g, " ");
  const prompt = d.prompt_used || d.user_input || "";
  const designId = String(d.id || "");
  const ext = (String(d.output_image_path).match(/\.(\w{2,5})$/) || [null, "png"])[1].toUpperCase();

  // Header: mode title + MMM DD, YYYY, h:mm A timestamp
  $("#expandTitle").textContent = d.feature ? (FEATURE_LABELS[d.feature] || d.feature) : (d.mode || "Design Preview");
  const dateObj = d.created_at ? new Date(d.created_at) : new Date();
  const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  $("#expandMeta").textContent = `${dateStr}, ${timeStr}`;
  $("#expandPrompt").textContent = prompt || "No prompt recorded for this design.";

  $("#expandMetaGrid").innerHTML = [
    metaItem("Mode", `<span class="badge badge-mode">${esc(FEATURE_LABELS[d.feature] || d.mode || "Design")}</span>`),
    metaItem("Dimensions", `<span id="expandDims">${esc(d.width || 1024)} × ${esc(d.height || 1024)} px PNG</span>`),
    metaItem("Folder", `<span class="badge badge-folder">${esc(d.folder || "Unsorted")}</span>`),
    metaItem("Design ID", `<span class="id-chip"><code title="${esc(designId)}">${esc(designId.slice(0, 8))}...</code><button type="button" class="copy-btn" id="expandCopyId" aria-label="Copy design ID" title="Copy design ID"><i data-lucide="copy"></i></button></span>`),
    metaItem("Commercial", `<span class="badge badge-success">✓ Print Ready</span>`),
  ].join("");

  // Real pixel dimensions come off the decoded bitmap, not the DB.
  const img = $("#expandModalImg");
  const token = ++expandLoadToken;
  const showDims = () => {
    if (token !== expandLoadToken || !img.complete) return;
    const dims = $("#expandDims");
    if (!dims) return;
    dims.textContent = img.naturalWidth && img.naturalHeight
      ? `${img.naturalWidth} × ${img.naturalHeight} px PNG`
      : `${d.width || 1024} × ${d.height || 1024} px PNG`;
  };
  img.onload = showDims;
  img.onerror = () => {
    const dims = $("#expandDims");
    if (dims && token === expandLoadToken) dims.textContent = "Unknown";
  };
  img.alt = d.user_input || featureLabel;
  img.src = designImageUrl(d);
  if (img.complete) showDims(); // cached images may never fire onload

  const copyPrompt = $("#expandCopyPrompt");
  copyPrompt.classList.toggle("hidden", !prompt);
  copyPrompt.onclick = () => copyWithFeedback(copyPrompt, prompt, "prompt");

  const copyId = $("#expandCopyId");
  copyId.onclick = () => copyWithFeedback(copyId, designId, "design ID");

  const dl = $("#expandDownload");
  dl.href = designImageUrl(d);
  dl.setAttribute("download", designFileName(d));

  $("#expandEdit").onclick = () => {
    m.classList.add("hidden");
    openEditModal(d);
  };
  m.classList.remove("hidden");
  renderIcons();
}

function openEditModal(d) {
  const m = $("#editModal");
  if (!m) return;
  $("#editModalImg").src = `/library/${esc(d.output_image_path)}`;
  const form = $("#editForm");

  form.onsubmit = async (e) => {
    e.preventDefault();
    const instruction = form.elements["edit_instruction"].value.trim();
    if (!instruction) return;

    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      await api(`/api/edit/${d.id}`, {
        method: "POST",
        body: JSON.stringify({ edit_instruction: instruction }),
      });
      m.classList.add("hidden");
      form.reset();
      await renderDesigns();
    } catch (err) {
      alert("Edit failed: " + err.message);
    } finally {
      submitBtn.disabled = false;
    }
  };
  m.classList.remove("hidden");
}

async function openMoveModal(d) {
  const m = $("#moveModal");
  if (!m) return;
  const pickList = $("#movePickList");
  pickList.innerHTML = `<p class="progress-line"><i data-lucide="refresh-cw"></i> Loading folders...</p>`;
  renderIcons();
  m.classList.remove("hidden");

  try {
    const data = await api("/api/designs?limit=100");
    const folders = [...new Set((data.rows || []).map((r) => r.folder).filter(Boolean))];
    if (!folders.includes("Unsorted")) folders.unshift("Unsorted");

    pickList.innerHTML = folders.map((f) => `
      <button type="button" class="pick-item ${f === (d.folder || 'Unsorted') ? 'active' : ''}" data-folder="${esc(f)}">
        <i data-lucide="folder"></i> <span>${esc(f)}</span>
      </button>
    `).join("");
    renderIcons();

    pickList.querySelectorAll(".pick-item").forEach((b) => {
      b.onclick = async () => {
        const target = b.dataset.folder === "Unsorted" ? "" : b.dataset.folder;
        await api(`/api/designs/${d.id}`, {
          method: "PATCH",
          body: JSON.stringify({ folder: target }),
        });
        m.classList.add("hidden");
        await renderDesigns();
      };
    });
  } catch {
    pickList.innerHTML = `<p class="note">Could not load folder list</p>`;
  }

  const newToggle = $("#moveNewToggle");
  const newForm = $("#moveNewForm");
  const newInput = $("#moveNewInput");
  const submitNew = $("#moveSubmitNew");

  if (newToggle && newForm) {
    newToggle.onclick = () => newForm.classList.toggle("hidden");
    submitNew.onclick = async () => {
      const name = newInput.value.trim();
      if (!name) return;
      await api(`/api/designs/${d.id}`, {
        method: "PATCH",
        body: JSON.stringify({ folder: name }),
      });
      newInput.value = "";
      m.classList.add("hidden");
      await renderDesigns();
    };
  }
}

function initLibraryModals() {
  const editModal = $("#editModal");
  const moveModal = $("#moveModal");
  const expandModal = $("#expandModal");

  $("#editModalClose")?.addEventListener("click", () => editModal?.classList.add("hidden"));
  $("#editCancel")?.addEventListener("click", () => editModal?.classList.add("hidden"));
  editModal?.addEventListener("click", (e) => {
    if (e.target === editModal) editModal.classList.add("hidden");
  });

  $("#moveModalClose")?.addEventListener("click", () => moveModal?.classList.add("hidden"));
  moveModal?.addEventListener("click", (e) => {
    if (e.target === moveModal) moveModal.classList.add("hidden");
  });

  $("#expandModalClose")?.addEventListener("click", () => expandModal?.classList.add("hidden"));
  expandModal?.addEventListener("click", (e) => {
    if (e.target === expandModal) expandModal.classList.add("hidden");
  });
}

/* ── Boot ────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  $$(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view))
  );

  const brandBar = $("#brandBar");
  if (brandBar) {
    brandBar.addEventListener("click", () => showView("home"));
  }

  // Top-bar brand lockup — same home shortcut as the sidebar brand bar.
  const brandLogo = $("#brandLogo");
  if (brandLogo) {
    brandLogo.addEventListener("click", (e) => {
      e.preventDefault();
      showView("home");
    });
  }

  // Global refresh button — reloads all application sections and synchronizes health
  const globalRefreshBtn = $("#globalRefreshBtn");
  if (globalRefreshBtn) {
    async function executeGlobalRefresh() {
      if (globalRefreshBtn.classList.contains("refreshing")) return;
      globalRefreshBtn.classList.add("refreshing");

      try {
        // 1. Refresh live top bar health and accounts data
        await refreshTopBar();
        if (typeof refreshAccountsData === "function") {
          await refreshAccountsData();
        }

        // 2. Clear cached view mounts so every view refreshes on demand
        mountedViews.clear();
        if (viewTeardown) {
          try { viewTeardown(); } catch (_) {}
          viewTeardown = null;
        }

        // 3. Clear existing rendered section HTML so they re-mount pristine
        document.querySelectorAll("#view > .app-section").forEach((sec) => {
          sec.innerHTML = "";
        });

        // 4. Re-mount and re-render current view with fresh server data
        const activeView = currentView || "home";
        mountedViews.add(activeView);
        const renderFn = views[activeView] || views.home;
        const res = renderFn();
        if (res && typeof res.then === "function") {
          await res;
        }
        renderIcons();

        // 5. Update aura host visibility
        const auraHost = document.getElementById("auraBgHost");
        if (auraHost) {
          auraHost.classList.toggle("hidden", activeView === "home");
        }
      } catch (err) {
        console.error("[globalRefresh] Refresh error:", err);
      } finally {
        setTimeout(() => {
          globalRefreshBtn.classList.remove("refreshing");
        }, 700);
      }
    }

    globalRefreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        window.location.reload();
        return;
      }
      executeGlobalRefresh();
    });
  }

  const themeToggle = $("#themeToggle");
  if (themeToggle) {
    // data-theme="light" on <html> and body.light-mode flips the light-token overrides in styles.css.
    // The icon mirrors the active theme; choice persists across reloads.
    const applyTheme = (theme) => {
      document.documentElement.setAttribute("data-theme", theme);
      document.body.classList.toggle("light-mode", theme === "light");
      themeToggle.innerHTML = `<i data-lucide="${theme === "light" ? "sun" : "moon"}"></i>`;
      renderIcons();
      try {
        localStorage.setItem("aliwebdesign-theme", theme);
      } catch { /* storage unavailable (private mode) */ }
    };

    themeToggle.addEventListener("click", () => {
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      applyTheme(isLight ? "dark" : "light");
    });

    let savedTheme = null;
    try {
      savedTheme = localStorage.getItem("aliwebdesign-theme");
    } catch { /* storage unavailable */ }
    if (savedTheme === "light" || savedTheme === "dark") {
      applyTheme(savedTheme);
    } else {
      document.body.classList.remove("light-mode");
    }
  }

  initLibraryModals();

  // Manual style inputs — the "×" clear button blanks the field. Delegated so
  // it works across every view (they mount once and persist).
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".clear-style-btn");
    if (!btn) return;
    const id = btn.dataset.clear;
    if (id) {
      const input = document.getElementById(id);
      if (input) input.value = "";
      input?.focus();
    }
  });

  // Style Catalog modal — open from the top-bar pill, searchable grid of all
  // styles, each with a "Copy Style" button that copies ONLY the clean style
  // name to the clipboard (full directives stay out of the copy).
  const styleCatalogModal = $("#styleCatalogModal");
  const styleCatalogBtn = $("#styleCatalogBtn");
  if (styleCatalogModal && styleCatalogBtn) {
    const grid = $("#styleCatalogGrid");
    const search = $("#styleCatalogSearch");
    let catalogStyles = [];

    const closeCatalog = () => styleCatalogModal.classList.remove("active");

    function renderCatalog(filter) {
      const q = String(filter || "").trim().toLowerCase();
      const list = q
        ? catalogStyles.filter(
          (s) =>
            (s.name || "").toLowerCase().includes(q) ||
            (s.category || "").toLowerCase().includes(q) ||
            (s.keywords || []).some((k) => String(k).toLowerCase().includes(q))
        )
        : catalogStyles;
      if (!list.length) {
        grid.innerHTML = `<p class="note">No styles match "${esc(String(filter || "").trim())}".</p>`;
        return;
      }
      grid.innerHTML = list
        .map(
          (s) => `
        <div class="style-catalog-card">
          <p class="style-catalog-card-title">${esc(s.name || "Untitled style")}</p>
          <p class="style-catalog-card-desc">${esc(s.description || "")}</p>
          <button type="button" class="style-catalog-copy-btn" data-style-name="${esc(s.name || "")}">
            <i data-lucide="copy"></i> Copy Style
          </button>
        </div>`
        )
        .join("");
      renderIcons();
    }

    async function loadCatalog() {
      grid.innerHTML = `<p class="progress-line"><i data-lucide="refresh-cw"></i> Loading styles...</p>`;
      renderIcons();
      try {
        const data = await api("/api/styles");
        catalogStyles = data.styles || [];
        renderCatalog("");
      } catch (err) {
        grid.innerHTML = `<p class="note">Could not load the style catalog: ${esc(err.message)}</p>`;
      }
    }

    styleCatalogBtn.addEventListener("click", () => {
      styleCatalogModal.classList.add("active");
      renderIcons();
      if (!catalogStyles.length) loadCatalog();
    });
    $("#styleCatalogClose")?.addEventListener("click", closeCatalog);
    styleCatalogModal.addEventListener("click", (e) => {
      if (e.target === styleCatalogModal) closeCatalog();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && styleCatalogModal.classList.contains("active")) closeCatalog();
    });
    search?.addEventListener("input", (e) => renderCatalog(e.target.value));

    // Copy ONLY the clean style name; button flips to "Copied! ✓" briefly.
    grid.addEventListener("click", (e) => {
      const btn = e.target.closest(".style-catalog-copy-btn");
      if (!btn) return;
      const name = btn.dataset.styleName || "";
      copyWithFeedback(btn, name, "style name");
      btn.innerHTML = `<i data-lucide="check"></i> Copied! ✓`;
      renderIcons();
      setTimeout(() => {
        btn.innerHTML = `<i data-lucide="copy"></i> Copy Style`;
        renderIcons();
      }, 1400);
    });
  }

  // About Us modal — open from the top-bar link, close via ✕, backdrop click
  // or Escape. Icons re-render on open so Lucide mounts inside the dialog.
  const aboutModal = $("#aboutModal");
  const navAboutBtn = $("#navAboutBtn");
  if (aboutModal && navAboutBtn) {
    const openAbout = () => {
      aboutModal.classList.add("active");
      renderIcons();
    };
    const closeAbout = () => aboutModal.classList.remove("active");

    navAboutBtn.addEventListener("click", openAbout);
    $("#aboutModalClose")?.addEventListener("click", closeAbout);
    aboutModal.addEventListener("click", (e) => {
      if (e.target === aboutModal) closeAbout();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && aboutModal.classList.contains("active")) closeAbout();
    });
  }

  initAccountsEventStream();
  refreshTopBar();
  setInterval(refreshTopBar, 15000);
  showView("home");
});

/* ── Pixel to Pixel View ─────────────────────────────────────────── */
