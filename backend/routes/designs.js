import { Router } from "express";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const archiver = require("archiver");
import { resolveLibraryPath, removeFileSafe } from "../lib/files.js";
import {
  getDesigns,
  getDesignById,
  deleteDesignRow,
  setDesignFolder,
  countPathRefs,
  listFolders,
} from "../lib/db.js";

const router = Router();

// GET /api/designs/folders — distinct folder names for the move-to-folder picker
router.get("/folders", (req, res) => {
  res.json({ folders: listFolders() });
});

// GET /api/designs?folder=&feature=&page=&pageSize= — newest first, paginated
router.get("/", (req, res) => {
  const { folder = null, feature = null } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(10000, Math.max(1, parseInt(req.query.pageSize, 10) || 60));
  res.json(getDesigns({ folder: folder || null, feature: feature || null, page, pageSize }));
});

// GET /api/designs/export?folder=&feature= — one zip of every matching output
// image, flat-named by design id (ready for marketplace upload). Streams.
router.get("/export", (req, res) => {
  const { folder = null, feature = null } = req.query;
  const f = folder || null;
  const feat = feature || null;

  // getDesigns caps pageSize at 200 — page through to collect everything.
  const rows = [];
  let page = 1;
  for (; ;) {
    const { rows: chunk, total } = getDesigns({ folder: f, feature: feat, page, pageSize: 200 });
    rows.push(...chunk);
    if (page * 200 >= total) break;
    page += 1;
  }

  if (rows.length === 0) {
    return res.status(404).json({ error: "No designs match those filters" });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="aliwebdesign-${stamp}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("warning", (err) => {
    if (err.code !== "ENOENT") console.error("zip warning:", err);
  });
  archive.on("error", (err) => {
    console.error("zip error:", err);
    res.destroy();
  });

  archive.pipe(res);
  for (const d of rows) {
    const abs = resolveLibraryPath(d.output_image_path);
    if (abs && fs.existsSync(abs)) archive.file(abs, { name: `${d.id}.png` });
  }
  archive.finalize();
});

// POST /api/designs/export-zip — one zip of the SELECTED design ids, named
// cleanly from each design's title/prompt (e.g. design_01_golden_retriever.png).
// body: { ids: string[] }. Streams a single attachment download.
router.post("/export-zip", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: "ids array is required" });
  }

  // Slug a design's display title into a filesystem-safe base name.
  const slug = (raw) =>
    String(raw || "design")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "design";

  const rows = [];
  for (const id of ids) {
    const d = getDesignById(id);
    if (d) rows.push(d);
  }
  if (rows.length === 0) {
    return res.status(404).json({ error: "No matching designs found" });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="designs_export_${stamp}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("warning", (err) => {
    if (err.code !== "ENOENT") console.error("zip warning:", err);
  });
  archive.on("error", (err) => {
    console.error("zip error:", err);
    res.destroy();
  });

  archive.pipe(res);
  rows.forEach((d, i) => {
    const abs = resolveLibraryPath(d.output_image_path);
    if (!abs || !fs.existsSync(abs)) return;
    const title = d.user_input && d.user_input !== d.feature ? d.user_input : d.feature;
    const ext = (String(d.output_image_path).match(/\.(\w{2,5})$/) || [null, "png"])[1].toLowerCase();
    const name = `design_${String(i + 1).padStart(2, "0")}_${slug(title)}.${ext}`;
    archive.file(abs, { name });
  });
  archive.finalize();
});

// PATCH /api/designs/:id — move to a folder
router.patch("/:id", (req, res) => {
  const design = getDesignById(req.params.id);
  if (!design) return res.status(404).json({ error: "Design not found" });
  const folder = String(req.body?.folder || "").trim();
  if (!folder) return res.status(400).json({ error: "folder is required" });
  setDesignFolder(design.id, folder);
  res.json({ design: getDesignById(design.id) });
});

// DELETE /api/designs/:id — remove the row + its files.
// A batch shares one source image across rows, so a file is only deleted when
// no remaining design still references it (output/source/style).
router.delete("/:id", (req, res) => {
  const design = getDesignById(req.params.id);
  if (!design) return res.status(404).json({ error: "Design not found" });

  deleteDesignRow(design.id);

  const candidatePaths = new Set(
    [design.output_image_path, design.source_image_path, design.style_image_path].filter(Boolean)
  );
  for (const rel of candidatePaths) {
    if (countPathRefs(rel) === 0) {
      const abs = resolveLibraryPath(rel);
      if (abs) removeFileSafe(abs);
    }
  }

  res.json({ ok: true });
});

export default router;