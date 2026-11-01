import { Router } from "express";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { upload, storeInLibrary, removeFileSafe } from "../lib/files.js";
import { insertDesign } from "../lib/db.js";
import { hasReadyAccount } from "../lib/accounts.js";
import { runFleetBatch } from "../lib/queue.js";
import { buildPrompt } from "../prompts/textToImage.js";
import { resolveStyle } from "../lib/styleResolver.js";
import { formatImageToAspectRatio } from "../lib/aspectRatioEnforcer.js";

const router = Router();

function formatDuration(ms) {
  const totalSec = Math.max(1, Math.round((ms || 0) / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

// POST /api/generate/text-to-image
// multipart: prompt (text), prompts (JSON array of strings or prompt profile objects), count (1–100), manualStyle (optional), reference images (optional: ref_0, reference, etc.)
router.post("/text-to-image", upload.any(), async (req, res) => {
  try {
    // Map uploaded files by fieldname (supporting multiple files per field)
    const filesByField = new Map();
    if (Array.isArray(req.files)) {
      for (const f of req.files) {
        if (!filesByField.has(f.fieldname)) {
          filesByField.set(f.fieldname, []);
        }
        filesByField.get(f.fieldname).push(f);
      }
    }

    // Parse prompts: support array of prompt objects OR array of strings
    // via req.body.prompts (JSON or array), or single prompt via req.body.prompt.
    let rawPrompts = [];
    if (req.body.prompts) {
      try {
        const parsed = typeof req.body.prompts === "string" ? JSON.parse(req.body.prompts) : req.body.prompts;
        if (Array.isArray(parsed)) {
          rawPrompts = parsed;
        }
      } catch (_) {
        if (typeof req.body.prompts === "string") {
          rawPrompts = [req.body.prompts.trim()].filter(Boolean);
        }
      }
    }
    if (rawPrompts.length === 0) {
      const single = String(req.body.prompt || "").trim();
      if (single) {
        rawPrompts = [single];
      }
    }

    const defaultGlobalCount = Math.min(100, Math.max(1, parseInt(req.body.count, 10) || 1));
    const defaultGlobalStyle = resolveStyle(req);
    const defaultGlobalBg = req.body.bg_color || req.body.background_color || "";
    const defaultGlobalRatio = String(req.body.aspectRatio || req.body.aspect_ratio || "1:1").trim();

    const storedFileCache = new Map();

    const normalizedPrompts = [];
    for (let pIdx = 0; pIdx < rawPrompts.length; pIdx++) {
      const item = rawPrompts[pIdx];
      let text = "";
      let itemRatio = defaultGlobalRatio;
      let itemCount = defaultGlobalCount;
      let itemBg = defaultGlobalBg;
      let itemStyle = defaultGlobalStyle;
      let hasReference = false;

      if (typeof item === "string") {
        text = item.trim();
        hasReference = Boolean(
          filesByField.has(`ref_${pIdx}`) ||
          filesByField.has(`reference_${pIdx}`) ||
          filesByField.has("reference") ||
          filesByField.has("source")
        );
      } else if (item && typeof item === "object") {
        text = String(item.prompt || item.text || "").trim();
        itemRatio = String(item.aspectRatio || item.aspect_ratio || defaultGlobalRatio).trim();
        itemCount = Math.min(100, Math.max(1, parseInt(item.count || item.variations, 10) || defaultGlobalCount));
        itemBg = item.bg_color !== undefined ? item.bg_color : (item.bgColor !== undefined ? item.bgColor : defaultGlobalBg);
        hasReference = Boolean(
          item.hasReference ||
          item.has_reference ||
          item.referenceCount > 0 ||
          item.referenceKey ||
          filesByField.has(`ref_${pIdx}`) ||
          filesByField.has(`reference_${pIdx}`)
        );

        // Resolve per-prompt style
        if (item.manualStyle || item.style_directive || item.style_name || item.style_id || item.magicStyle) {
          const manualStyle = String(item.manualStyle || "").trim();
          const magicStyle = item.magicStyle || {};
          const styleDirective = String(item.style_directive || magicStyle.directive || "").trim();
          const styleName = String(item.style_name || magicStyle.name || "").trim() || null;
          const styleId = String(item.style_id || magicStyle.id || "").trim() || null;
          itemStyle = resolveStyle({
            body: { manualStyle, style_directive: styleDirective, style_name: styleName, style_id: styleId },
          });
        }
      }

      if (!text) continue;

      // Collect ALL reference files attached for this prompt
      const promptRefFiles = [];

      // 1. Direct field matches (ref_0, reference_0)
      if (filesByField.has(`ref_${pIdx}`)) {
        promptRefFiles.push(...filesByField.get(`ref_${pIdx}`));
      }
      if (filesByField.has(`reference_${pIdx}`)) {
        promptRefFiles.push(...filesByField.get(`reference_${pIdx}`));
      }

      // 2. Indexed field matches (ref_0_0, ref_0_1, etc.)
      if (Array.isArray(req.files)) {
        for (const f of req.files) {
          if (
            (f.fieldname.startsWith(`ref_${pIdx}_`) || f.fieldname.startsWith(`reference_${pIdx}_`)) &&
            !promptRefFiles.includes(f)
          ) {
            promptRefFiles.push(f);
          }
        }
      }

      // 3. Fallbacks if single prompt or global reference
      if (promptRefFiles.length === 0 && (hasReference || rawPrompts.length === 1)) {
        for (const key of ["reference", "source", "image"]) {
          if (filesByField.has(key)) {
            promptRefFiles.push(...filesByField.get(key));
          }
        }
        if (promptRefFiles.length === 0 && Array.isArray(req.files) && req.files.length > 0 && rawPrompts.length === 1) {
          promptRefFiles.push(...req.files);
        }
      }

      const sourceAbsList = [];
      const sourceRelList = [];

      for (const promptRefFile of promptRefFiles) {
        if (promptRefFile && promptRefFile.path) {
          let storedRef = storedFileCache.get(promptRefFile.path);
          if (!storedRef) {
            const ext = path.extname(promptRefFile.originalname || promptRefFile.path || ".png") || ".png";
            storedRef = storeInLibrary(promptRefFile.path, `${uuidv4()}-reference${ext}`);
            storedFileCache.set(promptRefFile.path, storedRef);
          }
          sourceAbsList.push(storedRef.abs);
          sourceRelList.push(storedRef.rel);
        }
      }

      normalizedPrompts.push({
        prompt: text,
        aspectRatio: itemRatio,
        count: itemCount,
        bgColor: itemBg,
        style: itemStyle,
        styleId: itemStyle.style_id,
        sourceAbsList,
        sourceRelList,
        sourceAbs: sourceAbsList[0] || null,
        sourceRel: sourceRelList[0] || null,
      });
    }

    if (normalizedPrompts.length === 0) {
      return res.status(400).json({ error: "prompt is required" });
    }

    if (!hasReadyAccount()) {
      return res.status(503).json({ error: "No Gemini account is ready — open the Accounts tab and sign in" });
    }

    // One task per prompt & variation; runFleetBatch fans them out across the ENTIRE
    // ready fleet in parallel — each account runs its own profile browser concurrently.
    const tasks = [];
    for (let pIdx = 0; pIdx < normalizedPrompts.length; pIdx++) {
      const pProfile = normalizedPrompts[pIdx];
      const refCount = pProfile.sourceAbsList?.length || (pProfile.sourceAbs ? 1 : 0);
      const hasRef = refCount > 0;
      const allImagePaths = pProfile.sourceAbsList?.length ? pProfile.sourceAbsList : (pProfile.sourceAbs ? [pProfile.sourceAbs] : []);

      for (let v = 0; v < pProfile.count; v++) {
        tasks.push({
          originalPrompt: pProfile.prompt,
          promptIndex: pIdx,
          variantIndex: v,
          prompt: buildPrompt({
            prompt: pProfile.prompt,
            variant: v,
            style_directive: pProfile.style.style_directive,
            style_name: pProfile.style.style_name,
            bg_color: pProfile.bgColor,
            aspectRatio: pProfile.aspectRatio,
            hasReferenceImage: hasRef,
            referenceCount: refCount,
          }),
          imagePaths: allImagePaths,
          sourceRel: pProfile.sourceRelList?.[0] || pProfile.sourceRel || null,
          aspectRatio: pProfile.aspectRatio,
          bgColor: pProfile.bgColor,
          styleId: pProfile.styleId,
        });
      }
    }

    // Streaming (NDJSON) vs classic JSON response. The client requests
    // streaming via the Accept header or ?stream=true; each finished design
    // is flushed down the open connection the moment its buffer is saved.
    const wantsStream =
      req.headers.accept?.includes("application/x-ndjson") || req.query.stream === "true";

    // Abort on client disconnect (Stop button severs the HTTP connection) —
    // the fleet batch races its generations against this signal so nothing
    // keeps running (and no disk/DB writes happen) after the user cancels.
    const routeAbort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        routeAbort.abort();
      }
    });

    if (wantsStream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      // Keep-alive heartbeat every 15s to prevent socket drops during long 100-design batches
      const heartbeatInterval = setInterval(() => {
        if (!res.writableEnded) {
          try {
            res.write(JSON.stringify({ event: "heartbeat" }) + "\n");
          } catch (_) {}
        }
      }, 15000);

      let streamedCount = 0;
      try {
        await runFleetBatch(
          tasks,
          async ({ buffer, taskIndex, task, account, durationMs, totalDurationMs, retried }) => {
            if (routeAbort.signal.aborted) return null;
            const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio, { bg_color: task.bgColor });
            const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);
            const promptLabel = task.originalPrompt || normalizedPrompts[0]?.prompt || "Design";
            const effectiveStyleId = task.styleId;
            const design = insertDesign({
              id: uuidv4(),
              feature: "text-to-image",
              source_image_path: task.sourceRel || null,
              output_image_path: out.rel,
              prompt_used: task.prompt,
              user_input: effectiveStyleId ? `${promptLabel} [style:${effectiveStyleId}]` : promptLabel,
            });
            const decorated = {
              ...design,
              source_image_path: task.sourceRel || null,
              account_id: account?.id || null,
              account_email: account?.email || null,
              prompt_index: task.promptIndex,
              variant_index: task.variantIndex,
              generation_time: formatDuration(retried ? (totalDurationMs || durationMs) : durationMs),
              generation_time_ms: retried ? (totalDurationMs || durationMs) : durationMs,
            };
            streamedCount++;
            // STREAM CHUNK IMMEDIATELY TO CLIENT
            res.write(JSON.stringify({ event: "design", slotIndex: taskIndex, design: decorated }) + "\n");
            return decorated;
          },
          {
            signal: routeAbort.signal,
            onItemRetry: ({ taskIndex, attempt }) => {
              if (wantsStream && !res.writableEnded) {
                try {
                  res.write(JSON.stringify({ event: "slot_retrying", slotIndex: taskIndex, attempt }) + "\n");
                } catch (_) {}
              }
            },
            onItemError: async ({ taskIndex, error }) => {
              if (wantsStream && !res.writableEnded) {
                try {
                  res.write(JSON.stringify({ event: "slot_failed", slotIndex: taskIndex, error: error.message || "Generation failed" }) + "\n");
                } catch (_) {}
              }
            }
          }
        );

        if (streamedCount === 0) {
          console.warn(
            `[TextToImage] No slot returned an image buffer. Gemini may have generated a text-only refusal or the generation timed out.`
          );
          res.write(
            JSON.stringify({
              event: "error",
              error: "No image generated by Gemini for this design (possible safety refusal or timeout).",
            }) + "\n"
          );
        }
        res.write(JSON.stringify({ event: "done", count: streamedCount }) + "\n");
      } finally {
        clearInterval(heartbeatInterval);
      }
      res.end();
    } else {
      const savedDesigns = new Array(tasks.length);
      await runFleetBatch(
        tasks,
        async ({ buffer, taskIndex, task, account, durationMs, totalDurationMs, retried }) => {
          if (routeAbort.signal.aborted) return null;
          const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio, { bg_color: task.bgColor });
          const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);
          const promptLabel = task.originalPrompt || normalizedPrompts[0]?.prompt || "Design";
          const effectiveStyleId = task.styleId;
          const design = insertDesign({
            id: uuidv4(),
            feature: "text-to-image",
            source_image_path: task.sourceRel || null,
            output_image_path: out.rel,
            prompt_used: task.prompt,
            user_input: effectiveStyleId ? `${promptLabel} [style:${effectiveStyleId}]` : promptLabel,
          });
          const decorated = {
            ...design,
            source_image_path: task.sourceRel || null,
            account_id: account?.id || null,
            account_email: account?.email || null,
            prompt_index: task.promptIndex,
            variant_index: task.variantIndex,
            generation_time: formatDuration(retried ? (totalDurationMs || durationMs) : durationMs),
            generation_time_ms: retried ? (totalDurationMs || durationMs) : durationMs,
          };
          savedDesigns[taskIndex] = decorated;
          return decorated;
        },
        { signal: routeAbort.signal }
      );

      const designs = savedDesigns.filter(Boolean);
      if (designs.length === 0) {
        throw new Error("No image generated by Gemini for this design (possible safety refusal or timeout).");
      }
      res.json({ success: true, designs });
    }
  } catch (err) {
    console.error("text-to-image failed:", err);
    if (res.headersSent) {
      // Headers already flushed (streaming) — emit an error event instead.
      try {
        res.write(JSON.stringify({ event: "error", error: err.message || "Generation failed" }) + "\n");
        res.end();
      } catch (_) { /* connection already closed */ }
    } else {
      res.status(500).json({ error: "Generation failed" });
    }
  } finally {
    if (Array.isArray(req.files)) {
      for (const f of req.files) {
        removeFileSafe(f.path);
      }
    }
  }
});

export default router;
