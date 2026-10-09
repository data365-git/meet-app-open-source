# T4b — "Replace video with audio" (storage-save) — build spec — 2026-07-12

**Owner decision:** a button on the owner's own video → confirm dialog (explicit, irreversible) → server extracts audio from the stored video, makes the player serve audio, deletes the large video bytes, sets `metadata.isAudio=true`, KEEPS the AI analysis + transcript. No undo. Data-loss op → safety-first ordering is mandatory.

**Cannot be live-verified until the Contabo deploy** (deploys are blocked). Build + gate (tsc/vitest/build) + local commit; live-verify folds into the single Contabo verification. Because it is data-loss, the ordering below (verify-before-delete) is non-negotiable.

## Key insight (playback wiring — already researched)
Player fetches media via `/api/playlist?userId=..&videoId=..&videoType=mp4` → route (`apps/web/app/api/playlist/route.ts:279-303`) redirects to a signed URL for `${ownerId}/${videoId}/result.mp4`; if `result.mp4` is missing it falls back to `raw-upload.mp4/webm` (`:286-298`). **Therefore: write the extracted audio bytes to `result.mp4` in place (contentType `audio/mpeg`).** The existing mp4 route then serves audio for EVERY video regardless of original layout — zero playback rewiring. `isAudio=true` makes `CapVideoPlayer` render `AudioPlayerChrome`. A browser plays `audio/mpeg` served from a `.mp4`-named URL fine (content-type header wins).

## Scope (v1 — safe & bounded)
- Supported sources: a video that has `result.mp4` OR `raw-upload.mp4` OR `raw-upload.webm` (imported files + finalized mp4s — the common case). If none exists (segment-only recorded videos) → return `{ok:false, reason:"unsupported_source"}` gracefully; do NOT touch storage.
- v1 reclaims: the `result.mp4` video bytes (swapped to small audio) + `raw-upload.mp4`/`raw-upload.webm`. **Segment trees (`output/`, `combined-source/`) are NOT deleted in v1** (extra blast-radius on segment routes, unverifiable blind) — flag as v2.

## Server action — `apps/web/actions/video/replace-with-audio.ts` (`"use server"`)
Model after `apps/web/actions/video/retry-processing.ts` (auth) + `apps/web/actions/video/save-thumbnail.ts` (result-object return shape). Use the **Effect `bucket`** (`getStorageAccessForVideo` from `apps/web/lib/video-storage.ts:21`, run via `.pipe(runPromise)` from `@/lib/server`) — NOT the raw S3Client — so custom-bucket/Drive users are correct.

Signature: `export async function replaceVideoWithAudio(videoId: string): Promise<{ok: true; reclaimedFrom: string[]} | {ok: false; reason: string}>`

Exact ordering (SAFETY — never delete before the audio is proven readable):
1. **Auth+owner:** `const user = await getCurrentUser()` (`@cap/database/auth/session`); `if (!user) return {ok:false, reason:"unauthorized"}`. Load `const [video] = await db().select().from(videos).where(eq(videos.id, videoId))`; `if (!video) return {ok:false, reason:"not_found"}`; `if (video.ownerId !== user.id) return {ok:false, reason:"unauthorized"}`.
2. **Idempotency:** read `const meta = (video.metadata as VideoMetadata) ?? {}`; `if (meta.isAudio) return {ok:false, reason:"already_audio"}`.
3. **Resolve source key + signed URL:** try in order `result.mp4`, `raw-upload.mp4`, `raw-upload.webm` (keys `${video.ownerId}/${videoId}/<name>`). For each: `bucket.headObject(key)` (Effect `.option`); first that exists → `sourceKey`; `sourceUrl = bucket.getInternalSignedObjectUrl(sourceKey)`. If none → `{ok:false, reason:"unsupported_source"}`.
4. **Extract audio fully into memory FIRST:** `const audioBuf = await extractAudioToBuffer(sourceUrl)` (`apps/web/lib/audio-extract.ts:546` — returns a mono 24kHz 64kbps MP3 Buffer, `audio/mpeg`). This fully consumes the source before any write. If it throws → `{ok:false, reason:"extract_failed"}` (nothing mutated yet).
5. **Write audio to `result.mp4` in place:** `resultKey = ${ownerId}/${videoId}/result.mp4`; `bucket.putObject(resultKey, audioBuf, {contentType:"audio/mpeg", contentLength: audioBuf.length})`.
6. **VERIFY read-back (the gate before ANY delete):** `const head = bucket.headObject(resultKey)` → assert it exists and its size equals `audioBuf.length` (± a small tolerance). If verify fails → return `{ok:false, reason:"verify_failed"}` WITHOUT deleting anything. (The original raw-upload.* is still intact → no data loss.)
7. **Reclaim (best-effort, non-fatal):** delete `raw-upload.mp4` and `raw-upload.webm` IF they exist and are ≠ `resultKey`. Wrap each in try/catch → log, never throw. Collect the keys actually deleted into `reclaimedFrom`.
8. **Flip metadata:** `await patchVideoMetadata(videoId, (cur) => ({...cur, isAudio: true}))` (`apps/web/lib/video-metadata.ts:16` — transactional, keeps aiSummary etc.).
9. **Revalidate:** `revalidatePath(\`/s/${videoId}\`)`.
10. Return `{ok:true, reclaimedFrom}`.

## UI — button + confirm dialog
- **Gate prop:** in `apps/web/app/s/[videoId]/Share.tsx` (~`:506-517`, where `canRetryProcessing` etc. are computed), add `canReplaceWithAudio={viewerId === data.owner.id && !data.metadata?.isAudio}`. Thread it through `ShareVideo.tsx` (`:78-79,101-102,735`) to `CapVideoPlayer`.
- **Button:** in `CapVideoPlayer.tsx` beside the retry button (`:691-696`), when `canReplaceWithAudio`, render a subtle secondary button "Videoni audioga almashtirish" (storage-save). Clicking opens a confirm dialog — reuse the existing dialog/AlertDialog primitive from `@cap/ui` (find it; the retry path only uses a toast, so add a confirm here).
- **Confirm copy (explicit, irreversible) — i18n keys, uz/ru/en:**
  - Title (uz): "Videoni audioga almashtirasizmi?"
  - Body (uz): "Video fayl butunlay o'chiriladi va faqat audio qoladi (joy tejaladi). AI tahlil va transkript saqlanadi. **Bu amalni QAYTARIB BO'LMAYDI.**"
  - Confirm btn (uz): "Ha, almashtir" · Cancel: "Bekor qilish"
  - (ru/en parallel — match existing i18n file structure.)
- On confirm: call `replaceVideoWithAudio(videoId)`; disable the button + show progress; on `{ok:true}` → success toast + `router.refresh()` (so `isAudio` UI takes over); on `{ok:false}` → error toast keyed by `reason` (unsupported_source → "Bu video turini almashtirib bo'lmaydi"; already_audio → silent/refresh; others → generic error).

## Tests (Vitest — must FAIL when broken; mutation-check the safety gate)
`apps/web/actions/video/__tests__/replace-with-audio.test.ts` — mock the Effect bucket + db + `extractAudioToBuffer` + `patchVideoMetadata`:
1. non-owner → `{ok:false,"unauthorized"}`, and **no putObject / no deleteObject called**.
2. `meta.isAudio` already true → `{ok:false,"already_audio"}`, no storage calls.
3. no source key exists → `{ok:false,"unsupported_source"}`, no delete.
4. happy path → extract→put(result.mp4, audio/mpeg)→headObject verify→delete raw-upload.*→patchVideoMetadata isAudio:true; assert call ORDER (put BEFORE delete) and `reclaimedFrom`.
5. **SAFETY (mutation-critical): if `headObject` verify returns wrong/absent size → `{ok:false,"verify_failed"}` and `deleteObject` is NEVER called.** (Remove the verify guard → this test must go red.)
6. extract throws → `{ok:false,"extract_failed"}`, no put, no delete.

## Gate before done
`pnpm tsc -b` = 0 · `pnpm --filter @cap/web run test` green (incl. the 6 new tests) · `next build` SUCCESS. Then main-session diff review (data-loss → scrutinize the ordering + that no path deletes before verify). Mark **UNVERIFIED-LIVE until Contabo** in STATE.

## Do NOT
- Do not use the raw S3Client path (breaks custom-bucket/Drive users) — use the Effect bucket.
- Do not `deleteObjects` by prefix (would nuke the audio/.vtt/AI you're keeping) — delete explicit keys only.
- Do not delete anything before step 6 verify passes.
- Do not touch the transcription `.vtt`, thumbnail, or AI metadata.
