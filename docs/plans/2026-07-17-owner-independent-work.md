# Plan — everything I can do without the owner (2026-07-17)

**Goal it serves (owner re-baselined 2026-07-16):** *a meeting must NEVER fail to record or be silently lost.*
Everything below is ranked against that, not against tidiness.

**Constraints, non-negotiable:**
- **No deploy.** Everything lands on `qa-fixes` only. The extension release stays gated behind the owner's v0.3.2 device test.
- **No touching prod/Coolify/Cloudflare/Railway** — those are owner surfaces.
- **No re-litigating settled owner decisions**: free-tier Gemini stays; recording backup is deprioritized; extension camera stays hidden.
- **Surgical.** Every changed line traces to an item here. Spotted extras get logged, not bundled.
- **Every fix ships with a test that has teeth** (proven red before green) — the standing lesson from this session.

---

## Context: what the capture-reliability sweep found

A read-only 5-agent audit traced record → upload → post-upload. Verdict: the **web** recorder is genuinely well-defended (OPFS spool, orphan recovery, failure-blob download, toasts on every branch). The **extension** — which IS the meeting recorder — has none of that and carries several independent ways to lose a meeting. HIGH-1 (unequal multipart parts) is already fixed and committed (`3582cb9`). The rest are below.

---

## ⚖️ FABLE PLAN-REVIEW (2026-07-17) — verdict APPROVE-WITH-MUST-FIX. All folded below.

Fable verified all five P1 findings against the real code — **none dropped**, and P1.3 was *understated*. But three of my five fix specs had blast-radius holes that would have created new loss paths, and I missed the path that becomes dominant once P1.5 exists. Folded in full:

> **THE INVARIANT (Fable's unifying insight — every P1 spec below is written around it):**
> **(a) every state/queue mutation in the extension MUST flow through `enqueueRecorder`; (b) every salvage path MUST end in a durable, retryable completion record.**
> Three of the five must-fixes were variations of this one theme. Hold the invariant and the individual fixes stop being able to hurt each other.

**Folded must-fixes:** M1 salvage must not report failure on success · M2 error path must be enqueued · M3 keepalive alarm is cleared exactly when retries are needed · M4 retry driver must be serialized or it creates lost-updates · M5 `"uploading"` and `"finishing"` brick states · M6 (missing) no durable completion after a failed retry-drain · M7 `nextPartNumber` is wrong for gapped parts.
**Folded scoping corrections:** the `recover-cron` deferral reason was weak — the honest reason is that it needs a push to `main`, which is owner-gated. The purge decision must live as an OWNER TODO in STATE.md, not only in this file. **P3.3 moves up to land with/before P1.5** — it is the server-side backstop against exactly what a mis-built retry driver produces.

---

## IN SCOPE — ranked

### P1 — the recording-loss bugs (directly the owner's #1 goal)

**P1.1 — Extension: `RECORDER_ERROR` throws the entire recording away.**
`src/background/sw.ts:1035-1059` sets `kind:"error"` and notifies, but never calls `finalizeUpload()` **or** `abortUpload()`. Every part already uploaded — potentially a 2-hour meeting — is abandoned mid-multipart: not completed, not aborted, not recoverable. `finalizeRecording()` then early-returns because `state.kind !== "recording"`.
*Fix (Fable-corrected):* salvage first — but **(M2)** route the whole handler through `enqueueRecorder`: today it mutates state un-serialized, and `handleChunk`'s loop bails when it sees `kind !== "recording"` (`upload.ts:486,507`), so a concurrent error-write mid-loop drops uploaded parts from the state list and skips the rest — creating the exact gap this plan exists to prevent. `RECORDER_STOPPED` is already enqueued (`sw.ts:1030`); this must be too.
**(M1)** After finalize, **read the resulting state** — if it reached `"complete"` (`upload.ts:681`), keep it and notify "saved (may be truncated)". Only set `"error"` if finalize did NOT complete, and do not stomp finalize's own more specific reason (`upload.ts:549-561`). Naively writing `kind:"error"` after a successful finalize tells the user their saved recording failed.
*Test:* drive `RECORDER_ERROR` after N parts against a faked R2; assert `completeMultipart` was called, the byte count is reported, and — explicitly — **a successful salvage surfaces as `complete`, never `error`**.

**P1.2 — Extension: browser restart mid-recording → recording lost AND extension bricked.**
`sw.ts:1245-1273` (`onStartup`) notifies *"Uploading what was captured..."* — then never calls `finalizeUpload()`. State sits at `"uploading"` forever; `retryPendingUploads()` only drains the retry queue and no `complete` item exists. Worse, `isInProgress()` returns true for `"uploading"`, so **every future recording is refused** with "A recording is already in progress" until the user finds CANCEL. Silent loss + permanent brick, and the notification actively lies.
*Fix (Fable-corrected):* `await enqueueRecorder(() => finalizeUpload())` in the startup recovery branch — **(M5) and widen it beyond the `"recording"` branch, because two sibling brick states remain:**
- **persisted `"uploading"`** (crash during finalize): `onStartup` only starts keepalive → same brick. `finalizeUpload` already accepts `"uploading"`, so this is one condition wider.
- **persisted `"finishing"`**: `onStartup` handles it not at all, `isInProgress` includes it → brick. And `FinishingState` (`state.ts:89-92`) carries **only `videoId`** — no `uploadId`, no parts — so it is *unrecoverable as persisted*. Minimum: map startup-`"finishing"` to a terminal state so the extension unbricks. Better: enqueue the durable `complete` item **before** entering finishing.
**(M7)** `nextPartNumber` for `"uploading"` states is computed as `parts.length + 1` (`upload.ts:528-529`) — **wrong when parts have gaps** (part 3 queued → parts `[1,2,4]` → remainder uploaded as "4" → duplicate PartNumber 4 in the complete list via the non-upsert append at `:588`). This fix newly exercises that path on every restart recovery, so it must use `max(PartNumber)+1` and account for queued numbers.
*Test:* simulate startup from each of `"recording"` / `"uploading"` / `"finishing"`; assert finalize runs (or the state goes terminal), the extension is never left un-startable, and a gapped part list does not produce a duplicate PartNumber.

**P1.3 — Web recorder: a mid-recording MediaRecorder error is a silent no-op.**
`useMediaRecorderSetup.ts:116-123` — `onRecorderError` only calls `stopPromiseRejectRef.current`, which is assigned **only** inside `stopRecordingInternal`. Mid-recording it is null, so the handler does nothing: no toast, no phase change, no stop. The UI keeps ticking on a dead recorder; on `streaming-webm`, Stop later finalizes the parts uploaded so far → a **silently truncated video**. `scheduleInstantChunkGuard` does not cover this (it self-disables after the first chunk).
**Fable: this is UNDERSTATED.** A fatal recorder error also fires `stop`, and `onRecorderStop` (`:106-113`) then **discards the buffered chunks** (resolver is null → chunks cleared). On a later Stop, `stopRecordingInternal:128` returns null (recorder already inactive) → `streaming-webm` finalizes truncated (`useWebRecorder.ts:1288`); `buffered-raw` throws "No recording available" (`:1209-1211`) = total loss.
*Fix (Fable-corrected):* surface it — `toast.error` + `updatePhase("error")` — **and preserve the bytes**: naively "triggering the stop path" returns a null blob and `onRecorderStop` has already thrown the chunks away. The handler must install the stop-promise refs (or have `onRecorderStop` stash the blob when no resolver exists) **before** the stop event lands, then route into the normal upload path.
*Test:* fire a synthetic recorder error mid-recording; assert phase becomes error, the user is told, **and the captured bytes still reach the upload path** (not discarded) for both `streaming-webm` and `buffered-raw`.

**P1.4 — Extension: the dead-letter notification is a lie.**
`upload.ts:180-192` (`moveToDeadLetter`) notifies *"Upload failed — recording saved locally as fallback"*. Nothing ever reads `capExtDeadLetterQueue` back (grep: writes only) and the extension has **no** local fallback — no download, no recovery UI. The user is told their recording is safe when it is gone.
*Decision:* do NOT build a recovery UI in this pass (scope). **Change the message to state the truth.** A false reassurance is worse than a plain failure — the user would otherwise not re-record.
*Test:* assert the notification text no longer claims a local copy exists.

**P1.5 — Extension: the retry queue has backoff but no driver.**
`retryPendingUploads()` is called from exactly one place — `chrome.runtime.onStartup` (`sw.ts:1272`). `BACKOFF_SECONDS = [1,4,16,64,256]` implies a periodic driver that does not exist, so a queued item retries **once per browser restart**; `MAX_ATTEMPTS = 6` therefore means six restarts before dead-lettering.
*Fix (Fable-corrected):* **(M3)** do NOT piggyback the existing keepalive alarm — it is **cleared** at `finalizeRecording` (`sw.ts:426`) and `RECORDER_ERROR` (`sw.ts:1048`), i.e. precisely when items land in the retry queue and the user sits in error state, so it would change almost nothing. Create a **dedicated retry alarm** whenever the queue is non-empty; clear it when drained.
**(M4)** The driver MUST be serialized through `enqueueRecorder`. `getRetryQueue`/`setRetryQueue` (`upload.ts:185-192`) is get-then-set: an alarm-driven drain racing a live recording's `addToRetryQueue` (inside the enqueued `handleChunk`) is a classic lost update — a queued part silently vanishes → gap → corrupt or failed complete. **This fix, built naively, would itself become a recording-loss bug.**
*Test:* assert the alarm handler drains the queue, honours the backoff, **and is serialized** — a concurrent `addToRetryQueue` must not be lost. Serialization is an asserted behaviour, not an implementation detail.
*Ordering:* **P3.3 lands with or before this** — the server-side gap rejection is the backstop against exactly what a mis-built retry driver produces.

**P1.6 — (M6, Fable-found; I missed it) A failed retry-drain leaves NO durable route to completion — the dominant remaining loss path once P1.5 exists.**
`finalizeUpload` on `queuedPartsResult.failed` (`upload.ts:606-614`) sets error and returns — **no `"complete"` retry item is ever enqueued.** So even after P1.5's driver later uploads every queued part successfully, `completeMultipart` is never called again: a **fully-uploaded meeting stranded forever, silently.** Without this, success criterion #2 below is false.
*Fix:* enqueue a durable, retryable `complete` record whenever parts remain queued, so the drain can finish the job.
*Test:* fail a part → drain succeeds later → assert `completeMultipart` eventually runs and the recording lands.

### P2 — operability (the owner is a non-programmer; if I'm not here, he needs a runbook)

**P2.1 — `docs/RUNBOOK.md`.** Written for a non-programmer operator: rollback a bad deploy · restore the DB from an R2 dump · rotate each secret · what each cron does and how to tell if it's dead · who to call when the site is down. Must be concrete (exact commands/menus), not prose.
**P2.2 — Verify the DB restore ONCE, for real.** A backup nobody has restored is a hope, not a backup. Restore `data365-2026-07-17.sql.gz` into a **local throwaway MySQL** (never prod, never the live DB) and confirm the table/row counts are sane. Document the exact steps in the runbook.

### P3 — LOW security/correctness (cheap, from the SESSION-e audit)

**P3.1** — wrap transcript text in `<untrusted_transcript>` delimiters inside the Gemini prompts (prompt-injection from meeting content).
**P3.2** — `getFolderVideoIds` membership guard (ID-enumeration leak).
**P3.3** — server: return 400 instead of `console.warn` on a non-sequential part list (`multipart.ts:365-373`) — currently the last line of defence for the extension's gap-creating retry path.

---

## EXPLICITLY OUT OF SCOPE — and why (these are the judgement calls; challenge them)

- **Deletion/erasure purge (audit item #3).** ❌ **Deliberately NOT building it.** Wiring `Videos.permanentlyDelete` to a real R2 purge, *today*, would create the first unrecoverable delete path in a system with **no versioning and no backup** (both confirmed this session; the owner knowingly deprioritized backup). Today web delete is soft-only, which is accidentally protective. Building a hard purge now converts a survivable mistake into a permanent one. **Recommendation: soft-delete + a delayed purge (e.g. 30 days) — and only after the owner has a backup or explicitly accepts it.** Needs an owner decision, so it is not "work I can do without him".
- **Consent notice (audit item #4).** User-facing wording in 3 languages, and a legal statement. I can draft it; the owner must approve the words. Not owner-independent.
- **Biome backlog (~1231 findings / ~676 CRLF files).** Mechanical but touches 676 files. High diff-noise, non-zero risk, zero user value, and it would bury this session's real changes in the history. **Recommendation: separate dedicated pass, owner-scheduled.** The `lint` job is already isolated so it masks nothing.
- **`recover-cron.yml` on `main` is stale** (pings the retired Railway URL, missing the health-check + `poll-batch-jobs` steps). **The honest reason it is out of scope (Fable corrected my weaker one): it needs a push to `main`, which is owner-gated in this workspace.** (My original reason — "entangled with the Railway decision" — was unconvincing: pointing the cron at prod is separable from shutting Railway down.) Stays an owner-decision line in STATE.md, session-f block.
- **Popup `RETRY` (`sw.ts:1062-1069`) discards everything** — sets idle, orphaning the pending buffer and retry items. Fable flagged it; logged, not fixed. After P1.1/P1.2/P1.6 land it matters much less, but it is a real (if user-initiated) loss path. Candidate for the next pass.
- **Railway shutdown, R2 lifecycle rule for orphaned multiparts, firewall, domain, VPS reboot** — owner surfaces (his accounts/credentials).
- **Orphaned-multipart cleanup in code.** The right fix is an R2 lifecycle rule (`AbortIncompleteMultipartUpload`), which is bucket config = owner. Building a code-side sweeper instead would be the wrong tool.

---

## Method

1. **Fable plan-review of THIS file → fold must-fixes.** (in progress)
2. Execute P1 → P2 → P3. Each item: failing test first (**proven red**), then fix, then green.
3. Delegate implementation to Sonnet with per-item specs; **I review every diff line-by-line** (this session Sonnet's P0 fix introduced a real MV3-eviction regression that only a hard read caught — treat every delegated diff as a hypothesis).
4. Gates after each item: `pnpm typecheck` · `pnpm --filter @cap/web run test` · `pnpm --filter @cap/browser-extension run test` · extension build. Biome on changed files only.
5. Commit per item, push `qa-fixes`. **No deploy. No re-zip.**
6. Self-review the whole diff, then **Fable verifies my review**.
7. Update `docs/STATE.md`.

## Success criteria (verifiable, not vibes)

- Every P1 item has a test that **fails on the old behaviour** (demonstrated, pasted red output) and passes on the new.
- No extension recording-loss path **in the sweep OR named in the Fable review** is left both (a) silent and (b) unfixed, without an explicit written reason here. *(Fable: my original wording scoped this to "in the sweep", which let the review's own findings escape the criterion.)*
- **A successful salvage surfaces as `complete`, never `error`** — explicitly asserted (without this, P1.1 could pass its test while lying to the user in the popup).
- **The invariant holds**: no state or retry-queue mutation happens outside `enqueueRecorder`, and every salvage path ends in a durable, retryable completion record. Asserted by test, not by inspection.
- `test` + `guards` CI jobs green; `lint` unchanged (known-red backlog).
- Extension build exit 0; no NEW tsc errors beyond the known pre-existing global-scope collisions.
- `docs/RUNBOOK.md` exists and its DB-restore section has been executed once for real, against a throwaway DB.
