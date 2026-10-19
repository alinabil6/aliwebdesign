import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Router } from "express";
import multer from "multer";
import { pickMagicStyle } from "../lib/magicStyleSelector.js";
import { analyzeDesignStyles } from "../lib/magicStyleAnalyzer.js";
import { STYLES, getTaxonomies } from "../lib/stylesRegistry.js";
import { TMP_DIR } from "../lib/paths.js";
import { removeFileSafe } from "../lib/files.js";

const router = Router();
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `style-${uuidv4()}${ext}`);
  },
});
// multipart form: optional "image" file + optional "prompt" text field.
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });
// multi-image analysis: up to 100 designs, 100MB each.
const uploadMany = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 100 },
});

// GET /api/styles — list the catalog (id/name/category/keywords/directive)
router.get("/", (req, res) => {
    res.json({
        success: true,
        taxonomies: getTaxonomies(),
        styles: STYLES.map(({ id, name, category, keywords, directive }) => ({
            id,
            name,
            category,
            keywords,
            description: directive,
        })),
    });
});

// POST /api/styles/magic-suggest
// multipart/form-data: prompt (optional text), image (optional file)
router.post("/magic-suggest", upload.single("image"), async (req, res) => {
    try {
        const prompt = String(req.body?.prompt || "").trim();
        const imageBuffer = req.file ? await fs.promises.readFile(req.file.path) : null;
        if (!prompt && !imageBuffer) {
            return res.status(400).json({ error: "Provide a prompt and/or an image" });
        }

        const style = await pickMagicStyle({
            prompt,
            imageBuffer,
            feature: String(req.body?.feature || "magic-suggest"),
        });

        res.json({ success: true, style });
    } catch (err) {
        console.error("magic-suggest failed:", err);
        res.status(500).json({ error: "Style suggestion failed" });
    } finally {
        if (req.file?.path) removeFileSafe(req.file.path);
    }
});

// POST /api/styles/magic-style-analyze
// multipart/form-data: "images" (multiple files, field name "images").
// Runs per-design analysis in parallel across the pooled account engine and
// returns one structured analysis per design, aligned with upload order.
router.post("/magic-style-analyze", uploadMany.array("images", 100), async (req, res) => {
    const files = req.files || [];
    try {
        if (!files.length) {
            return res.status(400).json({ error: "Provide at least one design image" });
        }

        const imageBuffers = await Promise.all(files.map((f) => fs.promises.readFile(f.path)));

        const analyses = await analyzeDesignStyles({
            imageBuffers,
            feature: String(req.body?.feature || "magic-style-analyze"),
        });

        res.json({ success: true, analyses });
    } catch (err) {
        console.error("magic-style-analyze failed:", err);
        res.status(500).json({ error: "Style analysis failed" });
    } finally {
        for (const f of files) {
            if (f.path) removeFileSafe(f.path);
        }
    }
});

export default router;