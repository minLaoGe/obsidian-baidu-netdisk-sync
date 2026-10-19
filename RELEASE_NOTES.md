## Unreleased — Concurrent uploads, delta sync, and manual conflict review

### Added

- Configurable 1–3 upload workers for independent files, defaulting to three.
- Unchanged-content local saves skip network requests; unchanged full syncs skip directory creation and baseline rewrites. Sync summaries report skipped files.
- Persistent, human-reviewed conflicts with notices, status-bar count, settings/command entry points, original/remote snapshot links, refresh, and explicit resolution confirmation.
- Delete-versus-edit conflicts also await human review. Pending originals and snapshot copies are excluded from automatic sync; remote changes invalidate stale confirmation.

### Fixed and preserved

- Correct precreate return types and required-block handling; fix create error 31500.
- Let Obsidian calculate multipart Content-Length; fix ERR_INVALID_ARGUMENT.
- Serialize token refresh and atomic state checkpoints; stop dispatch and drain in-flight workers on checkpoint failure.
- Preserve per-file upload order, full/incremental sync isolation, local atomic replacement, and crash recovery. Hash actual uploaded bytes and recheck local content after queuing.
- Older automatic winner preferences no longer apply; original files are not overwritten merely to clear conflicts.

### Validation and upgrade

- TypeScript, production build, 104 reliability assertions, concurrency, delta and upload-protocol tests pass.
- Four real Baidu trials: serial 11.747/14.470s versus three workers 5.299/3.531s (about 2.97× by mean); 36 files and a separate multi-part file verified byte-for-byte after download.
- Wait for active sync to finish before reloading the updated plugin. Preserve credentials and existing sync state. Legacy conflict copies remain local; they are not retroactively assigned invented conflict baselines.
- Per-file atomicity is retained; this is not a vault-wide or cross-device transaction. This commit does not publish a release or change the release version.

## 1.0.4

- Address the community scanner UI errors: use Setting headings and CSS classes for settings and modal layouts.
- Keep dynamic pairing controls hidden until generation completes and use severity classes for log colors.
- Clarify desktop-only setup help; includes English documentation and all reliability fixes from 1.0.2.
- Typecheck, 71 reliability assertions, and production build pass.

Requires desktop Obsidian 1.14.4+. Community directory automated review is in progress.
