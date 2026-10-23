import { Router } from "express";
import fs from "fs";
import * as archiverPkg from "archiver";

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
router.get("/export", async (req, res) => {
  try {
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

    const filesToZip = [];
    for (const d of rows) {
      const abs = resolveLibraryPath(d.output_image_path);
      if (abs && fs.existsSync(abs)) {
        filesToZip.push({ abs, name: `${d.id}.png` });
      }
    }

    if (filesToZip.length === 0) {
      return res.status(404).json({ error: "No design image files found on disk" });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="aliwebdesign-${stamp}.zip"`);

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
    console.error("Export all designs route error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Failed to generate zip export" });
    } else {
      res.destroy();
    }
  }
});

// POST /api/designs/export-zip — one zip of the SELECTED design ids, named
// cleanly from each design's title/prompt (e.g. design_01_golden_retriever.png).
// body: { ids: string[] }. Streams a single attachment download.
router.post("/export-zip", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String).filter(Boolean) : [];

    if (ids.length === 0 && paths.length === 0) {
      return res.status(400).json({ error: "ids or paths array is required" });
    }

    // Slug a design's display title into a filesystem-safe base name.
    const slug = (raw) =>
      String(raw || "design")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "design";

    const filesToZip = [];
    const addedAbs = new Set();

    // 1. Resolve files by design ID from database
    for (const id of ids) {
      const d = getDesignById(id);
      if (!d) continue;
      const abs = resolveLibraryPath(d.output_image_path);
      if (!abs || !fs.existsSync(abs) || addedAbs.has(abs)) continue;
      addedAbs.add(abs);
      const ext = (String(d.output_image_path).match(/\.([a-zA-Z0-9]{2,5})$/) || [null, "png"])[1].toLowerCase();
      let name;
      if (d.feature === "prepare-designs") {
        name = `prepared_print_4500x5400_${String(filesToZip.length + 1).padStart(2, "0")}.${ext}`;
      } else {
        const title = d.user_input && d.user_input !== d.feature ? d.user_input : d.feature;
        name = `design_${String(filesToZip.length + 1).padStart(2, "0")}_${slug(title)}.${ext}`;
      }
      filesToZip.push({ abs, name });
    }

    // 2. Resolve any direct library paths passed by client
    for (const p of paths) {
      const abs = resolveLibraryPath(p);
      if (!abs || !fs.existsSync(abs) || addedAbs.has(abs)) continue;
      addedAbs.add(abs);
      const ext = (String(p).match(/\.([a-zA-Z0-9]{2,5})$/) || [null, "png"])[1].toLowerCase();
      const name = `prepared_print_4500x5400_${String(filesToZip.length + 1).padStart(2, "0")}.${ext}`;
      filesToZip.push({ abs, name });
    }

    if (filesToZip.length === 0) {
      return res.status(404).json({ error: "Selected design image files were not found on disk" });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const downloadName = req.body?.filename
      ? String(req.body.filename).replace(/[^a-zA-Z0-9._-]/g, "_")
      : `designs_export_${stamp}.zip`;

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
    console.error("Export all designs route error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Failed to generate zip export" });
    } else {
      res.destroy();
    }
  }
});

// POST /api/designs/export-zip — one zip of the SELECTED design ids, named
// cleanly from each design's title/prompt (e.g. design_01_golden_retriever.png).
// body: { ids: string[] }. Streams a single attachment download.
router.post("/export-zip", async (req, res) => {
  try {
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

    const filesToZip = [];
    rows.forEach((d, i) => {
      const abs = resolveLibraryPath(d.output_image_path);
      if (!abs || !fs.existsSync(abs)) return;
      const title = d.user_input && d.user_input !== d.feature ? d.user_input : d.feature;
      const ext = (String(d.output_image_path).match(/\.(\w{2,5})$/) || [null, "png"])[1].toLowerCase();
      const name = `design_${String(i + 1).padStart(2, "0")}_${slug(title)}.${ext}`;
      filesToZip.push({ abs, name });
    });

    if (filesToZip.length === 0) {
      return res.status(404).json({ error: "Selected design image files were not found on disk" });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="designs_export_${stamp}.zip"`);

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
    console.error("Export zip route error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Failed to generate zip export" });
    } else {
      res.destroy();
    }
  }
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