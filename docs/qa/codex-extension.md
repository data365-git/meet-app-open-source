# Codex — F006: extension upload part-retry loses the part bytes

RULES: own ONLY files under `apps/browser-extension/src/background/` (primarily `upload.ts`); no other files; no git. Minimal + type-safe. (This is the Chrome MV3 extension package, separate from @cap/web.)

BUG: When an upload PART fails, the retry queue (`addToRetryQueue` → `chrome.storage.local`) stores only metadata (partNumber/videoId/uploadId), NOT the part's bytes — the bytes were already drained from the in-memory buffer. So on retry, the `kind === "part"` branch immediately `moveToDeadLetter`; the part can never be re-uploaded, leaving a gap that fails the whole multipart upload.

FIX: retain the failed part's data so it can actually be retried. Pick the cleanest approach that fits the code:
- (a) keep the part's bytes until its PUT succeeds; on failure, persist the bytes with the retry item (e.g. base64 in chrome.storage, or an in-memory map keyed by partNumber+uploadId) so retry re-PUTs the SAME bytes; OR
- (b) if persisting bytes is impractical, re-buffer the part on failure so it can be re-sent.
A retried part MUST upload the same bytes. Keep dead-letter only for genuinely unrecoverable cases.

Verify the extension still builds/typechecks (find the extension package name in `apps/browser-extension/package.json`, then run its build or typecheck script).

REPORT: files changed, the approach, and the extension build/typecheck result. No git.
