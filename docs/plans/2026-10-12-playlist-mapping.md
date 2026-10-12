# Playlist folder mapping implementation plan

**Goal:** Support nested playlist folders, explicit one-to-one mappings, editable per-track sync plans with undo/redo, and efficient polling.

**Architecture:** Store library-relative folder paths and explicit custom mappings in SQLite. Resolve unique same-name directories with root-level priority; never choose among ambiguous directories. Keep song decisions separate from filesystem operations and execute them only during a validated playlist sync.

**Tech Stack:** Electron, React, Express, sql.js, Node test runner, Playwright.

## 1. Directory resolution and mapping

- Modify `src/backend/file-store.cjs` to index nested directories, exclude reserved directories and links, validate real paths and preserve parents on rename.
- Modify `src/backend/database.cjs` to migrate the mapping flag and add persisted song decisions.
- Modify `src/backend/app-service.cjs` to discover unique matches and validate exclusive folder ownership and online IDs for every sync.
- Add temporary-library integration tests for nested paths, root priority, ambiguity, manual remapping and invalid targets.

## 2. Song plans

- Add per-playlist APIs in `src/backend/server.cjs` and `src/renderer/api.js` for details and saved song decisions.
- Reject stale revisions and edits during scans or active tasks.
- Make keep/download/delete decisions survive rescans; explicit decisions override the global removal setting.
- Test skip, keep, delete, shared entities and isolation between playlists.

## 3. Interface and performance

- Show full paths and mapping entry points in `src/renderer/main.jsx`.
- Create a paginated three-column editor with drag/drop, equivalent buttons, undo/redo and keyboard shortcuts. Saving only changes the plan; syncing applies it.
- Poll summaries rather than full song arrays; fetch details when opened. Batch relationship reads and use sets for diff membership.
- Add Electron E2E coverage for mapping, drag/drop, undo, save and scoped sync.

## 4. Validation and delivery

- Run `npm.cmd test` and `npm.cmd run test:e2e` with mock accounts and temporary libraries.
- Inspect the rendered editor and mapping dialog, update README and prepare a PR description.
- Do not package or touch any existing user music library.
