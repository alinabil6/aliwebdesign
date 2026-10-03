import { Router } from "express";
import { cancelAllRunningFleetTasks } from "../lib/queue.js";

const router = Router();

// POST /api/generate/cancel
// Global emergency kill-switch — aborts every active fleet batch, drains
// pending queues, and force-unleases all leased accounts back to "ready".
// Called by the frontend Stop button in every generation view.
router.post("/cancel", (req, res) => {
    try {
        const result = cancelAllRunningFleetTasks();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;