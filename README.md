# aliwebdesign

AI-assisted design generation and listing review workspace.

## Setup

1. Install dependencies: `npm ci`
2. Start the app: `npm run dev`
3. Open the local frontend served by `server.js`

## Security notes

Protected routes now require JWT-based authorization in production:

- `/api/magic-listing/*` → `ai.listing:generate`
- `/api/styles/*` → `ai.styles:analyze`
- `/api/generate/*` → `ai.generate:run`

Set `AUTH_JWT_SECRET` in environments where auth is enforced. For local development only, a localhost-only bypass remains enabled unless `ALLOW_LOCAL_DEV_AUTH_BYPASS=0`.

## Magic Listing review workflow

The Magic Listing flow now returns a normalized review contract containing:

- `suggested_title`
- `suggested_category`
- `suggested_price_range`
- `bullet_points`
- `confidence_score`
- `requires_manual_review`
- `source`
- `grounding_notes`
- `platform_payload`

The frontend review card supports field-level accept, edit, reset, and CSV export using the reviewed values.

## Persistence

SQLite now stores:

- `listing_review_sessions`
- `listing_field_reviews`
- `taxonomy_audit_log`

These support durable review state and auditability for listing decisions.

## Feature Maturity Matrix

| Feature | Status | Notes |
|---|---|---|
| Design generation | Mature | Existing multi-route generation flow retained |
| Magic Listing image transport | Mature | Vision payload already wired end-to-end |
| Magic Listing normalized contract | Improved | Structured review payload + confidence/source signals |
| Field-level review UX | Improved | Accept/edit/reset per field + reviewed CSV export |
| Auth hardening | Improved | JWT + scope enforcement for AI-sensitive routes |
| Review persistence | Improved | SQLite review sessions, field reviews, audit log |
| Automated testing | Baseline | Unit + integration + contract coverage added |
| CI/CD | Baseline | Node LTS workflow with lint and test gates |
