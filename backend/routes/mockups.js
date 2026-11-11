import { Router } from "express";
import fs from "fs";
import * as archiverPkg from "archiver";
import { resolveLibraryPath, removeFileSafe } from "../lib/files.js";
import {
  getMockups,
  getMockupById,
  deleteMockupRow,
  setMockupFolder,
  listMockupFolders,
  countPathRefs,
} from "../lib/db.js";

function createZipArchive(options = { zlib: { level: 6 } }) {
  if (typeof archiverPkg.ZipArchive === "function") {
    return new archiverPkg.ZipArchive(options);
  }
  const defaultExport = archiverPkg.default || archiverPkg;
  if (typeof defaultExport === "function") {
    return defaultExport("zip", options);
  }
  if (defaultExport && typeof defaultExport.ZipArchive === "function") {
    return new defaultExport.ZipArchive(options);
  }
  throw new Error("Unable to initialize ZipArchive from archiver module");
}

const router = Router();

// GET /api/mockups/folders — distinct folders for mockups
router.get("/folders", (req, res) => {
  res.json({ folders: listMockupFolders() });
});

// GET /api/mockups?folder=&page=&pageSize= — paginated mockups, newest first
router.get("/", (req, res) => {
  const { folder = null } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(10000, Math.max(1, parseInt(req.query.pageSize, 10) || 60));
  const result = getMockups({ folder: folder || null, page, pageSize });

  // Decorate each row with feature: "mockups" and isMockup: true for frontend UI compatibility
  result.rows = (result.rows || []).map((row) => ({
    ...row,
    feature: "mockups",
    isMockup: true,
  }));

  res.json(result);
});

// GET /api/mockups/export?folder= — export all matching mockups as zip
router.get("/export", async (req, res) => {
  try {
    const { folder = null } = req.query;
    const f = folder || null;

    const rows = [];
    let page = 1;
    for (; ;) {
      const { rows: chunk, total } = getMockups({ folder: f, page, pageSize: 200 });
      rows.push(...chunk);
      if (page * 200 >= total) break;
      page += 1;
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: "No mockups match that folder filter" });
    }

    const filesToZip = [];
    for (const m of rows) {
      const abs = resolveLibraryPath(m.output_image_path);
      if (abs && fs.existsSync(abs)) {
        filesToZip.push({ abs, name: `mockup_${m.id}.png` });
      }
    }

    if (filesToZip.length === 0) {
      return res.status(404).json({ error: "No mockup image files found on disk" });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="mockups_export_${stamp}.zip"`);

    const archive = createZipArchive({ zlib: { level: 6 } });
    archive.on("warning", (err) => {
      if (err.code !== "ENOENT") console.error("zip warning:", err);
    });
    archive.on("error", (err) => {
      console.error("zip error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Zip compression error: " + err.message });
      } else {
        res.destroy();
      }
    });

    archive.pipe(res);
    for (const item of filesToZip) {
      archive.file(item.abs, { name: item.name });
    }
    await archive.finalize();
  } catch (err) {
    console.error("Export all mockups error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Failed to generate zip export" });
    } else {
      res.destroy();
    }
  }
});

// POST /api/mockups/export-zip — zip of selected mockup IDs
router.post("/export-zip", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: "ids array is required" });
    }

    const slug = (raw) =>
      String(raw || "mockup")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "mockup";

    const rows = [];
    const seenIds = new Set();
    for (const id of ids) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const m = getMockupById(id);
      if (m) rows.push(m);
    }
    if (rows.length === 0) {
      return res.status(404).json({ error: "No matching mockups found" });
    }

    const filesToZip = [];
    const addedAbs = new Set();
    const usedNames = new Set();
    for (const m of rows) {
      const abs = resolveLibraryPath(m.output_image_path);
      if (!abs || !fs.existsSync(abs) || addedAbs.has(abs)) continue;
      addedAbs.add(abs);
      const title = m.user_input || m.product_type || "mockup";
      const ext = (String(m.output_image_path).match(/\.([a-zA-Z0-9]{2,5})$/) || [null, "png"])[1].toLowerCase();
      let name = `mockup_${String(filesToZip.length + 1).padStart(2, "0")}_${slug(title)}.${ext}`;
      if (usedNames.has(name)) {
        const shortId = String(m.id || filesToZip.length + 1).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8);
        name = `mockup_${String(filesToZip.length + 1).padStart(2, "0")}_${slug(title)}_${shortId}.${ext}`;
      }
      usedNames.add(name);
      filesToZip.push({ abs, name });
    }

    if (filesToZip.length === 0) {
      return res.status(404).json({ error: "Selected mockup image files were not found on disk" });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const downloadName = req.body?.filename
      ? String(req.body.filename).replace(/[^a-zA-Z0-9._-]/g, "_")
      : `mockups_export_${stamp}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);

    const archive = createZipArchive({ zlib: { level: 6 } });
    archive.on("warning", (err) => {
      if (err.code !== "ENOENT") console.error("zip warning:", err);
    });
    archive.on("error", (err) => {
      console.error("zip error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Zip compression error: " + err.message });
      } else {
        res.destroy();
      }
    });

    archive.pipe(res);
    for (const f of filesToZip) {
      archive.file(f.abs, { name: f.name });
    }
    await archive.finalize();
  } catch (err) {
    console.error("Export zip mockups error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Failed to generate zip export" });
    } else {
      res.destroy();
    }
  }
});

// PATCH /api/mockups/:id — move mockup to a folder
router.patch("/:id", (req, res) => {
  const mockup = getMockupById(req.params.id);
  if (!mockup) return res.status(404).json({ error: "Mockup not found" });
  const folder = String(req.body?.folder || "").trim();
  if (!folder) return res.status(400).json({ error: "folder is required" });
  setMockupFolder(mockup.id, folder);
  res.json({ mockup: getMockupById(mockup.id) });
});

// DELETE /api/mockups/:id — remove the row + unreferenced files
router.delete("/:id", (req, res) => {
  const mockup = getMockupById(req.params.id);
  if (!mockup) return res.status(404).json({ error: "Mockup not found" });

  deleteMockupRow(mockup.id);

  const candidatePaths = new Set(
    [mockup.output_image_path, mockup.source_image_path, mockup.style_image_path].filter(Boolean)
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
