import { Router } from "express";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { resolveLibraryPath, removeFileSafe, storeInLibrary } from "../lib/files.js";
import {
  getListings,
  getListingById,
  insertListing,
  deleteListingRow,
  deleteListingsBatch,
  countListingThumbnailRefs,
  countPathRefs,
  totalListingsCount,
} from "../lib/db.js";

const router = Router();

// GET /api/listings/count — total number of saved listings
router.get("/count", (req, res) => {
  res.json({ total: totalListingsCount() });
});

// GET /api/listings — newest first, filtered & paginated
router.get("/", (req, res) => {
  const { platform = null, search = null } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(10000, Math.max(1, parseInt(req.query.pageSize, 10) || 100));
  const data = getListings({
    platform: platform || null,
    search: search || null,
    page,
    pageSize,
  });
  res.json(data);
});

// GET /api/listings/:id — single listing details
router.get("/:id", (req, res) => {
  const listing = getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: "Listing not found" });
  res.json({ listing });
});

// POST /api/listings — manually save a listing
router.post("/", (req, res) => {
  try {
    const {
      fileName = "",
      platform = "amazon",
      thumbnailBase64 = "",
      thumbnailPath = null,
      listing = {},
    } = req.body || {};

    let thumbRel = thumbnailPath || null;
    if (!thumbRel && thumbnailBase64) {
      const base64Data = String(thumbnailBase64).replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(base64Data, "base64");
      const stored = storeInLibrary(buf, `${uuidv4()}-listing-thumb.jpg`);
      thumbRel = stored.rel;
    }

    const plat = String(platform || "amazon").toLowerCase();
    const isSocial = plat === "social";
    const l = listing || {};

    const saved = insertListing({
      id: uuidv4(),
      file_name: fileName || "Untitled Listing",
      platform: plat,
      thumbnail_path: thumbRel,
      title: isSocial
        ? (l.pod_title || l.title || l.pinterest?.pin_title || l.facebook?.post_title || l.instagram?.hook || l.tiktok?.video_title || l.summary || "Social Media Listing")
        : (l.title || null),
      brand: isSocial ? (l.target_audience || "Social Media") : (l.brand || l.brand_name || l.brandName || null),
      category: isSocial ? "Social Media > Multi-Platform" : (l.category || null),
      bullet1: isSocial ? (l.instagram?.hook || null) : (l.bullet1 || l.bullet_1 || null),
      bullet2: isSocial ? (l.facebook?.post_title || null) : (l.bullet2 || l.bullet_2 || null),
      description: isSocial ? (l.summary || l.instagram?.caption || l.pinterest?.pin_description || null) : (l.description || l.desc || null),
      main_tag: isSocial ? (l.pinterest?.board_name || l.pinterest?.board || l.pinterest?.recommended_board || "Social Media") : (l.mainTag || l.main_tag || null),
      tags: isSocial
        ? [
            ...(Array.isArray(l.instagram?.hashtags) ? l.instagram.hashtags : []),
            ...(Array.isArray(l.pinterest?.search_keywords) ? l.pinterest.search_keywords : []),
            ...(Array.isArray(l.tiktok?.hashtags) ? l.tiktok.hashtags : [])
          ].slice(0, 25)
        : (l.tags || l.supportingTags || l.supporting_tags || []),
      attributes: isSocial ? (l.attributes || { platforms: l._selectedPlatforms || ["instagram", "facebook", "pinterest", "tiktok"], target_audience: l.target_audience || "" }) : (l.attributes || {}),
      trademark_safe: l.trademark_safe !== false ? 1 : 0,
      raw_listing: l,
    });

    res.status(201).json({ success: true, listing: saved });
  } catch (err) {
    console.error("[Listings POST error]:", err);
    res.status(500).json({ error: err.message || "Failed to save listing" });
  }
});

// DELETE /api/listings/:id — remove single listing + unreferenced thumbnail
router.delete("/:id", (req, res) => {
  const listing = getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: "Listing not found" });

  deleteListingRow(listing.id);

  if (listing.thumbnail_path) {
    const rel = listing.thumbnail_path;
    // Only remove if not referenced in any other listings or designs
    if (countListingThumbnailRefs(rel) === 0 && countPathRefs(rel) === 0) {
      const abs = resolveLibraryPath(rel);
      if (abs) removeFileSafe(abs);
    }
  }

  res.json({ ok: true, deletedId: listing.id });
});

// POST /api/listings/delete-batch — delete multiple listings in one request
router.post("/delete-batch", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: "ids array is required" });
  }

  const thumbnailsToCheck = new Set();
  for (const id of ids) {
    const item = getListingById(id);
    if (item?.thumbnail_path) {
      thumbnailsToCheck.add(item.thumbnail_path);
    }
  }

  const deletedCount = deleteListingsBatch(ids);

  for (const rel of thumbnailsToCheck) {
    if (countListingThumbnailRefs(rel) === 0 && countPathRefs(rel) === 0) {
      const abs = resolveLibraryPath(rel);
      if (abs) removeFileSafe(abs);
    }
  }

  res.json({ ok: true, count: deletedCount });
});

export default router;
