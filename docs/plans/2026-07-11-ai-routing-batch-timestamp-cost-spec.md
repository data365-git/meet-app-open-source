# Ustoz AI routing, durable Batch, and timestamp-cost specification

Date: 2026-07-11  
Status: APPROVED FOR LOCAL IMPLEMENTATION; no push/deploy  
Owner intent: reduce AI spend without lowering transcript/analysis quality or making the **Tez** path feel slow.

## 0. Read this first

Before editing, read these files completely, in this order:

1. `AGENTS.md`
2. `CLAUDE.md`
3. the TOP/current block of `docs/STATE.md`
4. `docs/_codex-wave2c-batch.txt`
5. `docs/adr/2026-07-08-ai-cost-tier-and-scribe-timing.md`
6. `docs/plans/2026-07-08-cost-tier-plan.md`
7. `docs/plans/2026-07-08-scribe-timing-transfer.md`
8. this specification

Then cross-check the current branch and commits with:

```powershell
git status --short --branch
git log --oneline -20
```

The checkout is intentionally dirty with many old untracked QA/scratch files. Do not delete, clean, stage, reformat, or move them. Do not use `git reset --hard`, `git clean`, or a destructive checkout. One editing agent only.

Scope contract:

> Only change Gemini free/paid routing deadlines, durable cheap-mode transcription Batch orchestration, directly required lifecycle/accounting tests, timestamp A/B research artifacts, and safe ElevenLabs configuration documentation. Do not change production prompts, transcript UI, recorder/upload behavior, unrelated AI features, database SQL schema, or production state. An experimental structured-output prompt may exist only inside the benchmark harness.

Do not commit, push, deploy, or set Railway/GitHub variables without a fresh explicit owner instruction after the local diff and gates are reviewed.

## 1. Product behavior to deliver

### Tez (`fast`)

For both transcription and summary/refine calls:

```text
free project/key + gemini-3.5-flash
  -> success inside a short bounded probe window: use it, $0
  -> quota, timeout, malformed/empty response, or other failure: immediately use
     the existing paid Standard path, primary gemini-3-flash-preview
```

Requirements:

- The free probe is exactly one attempt in Tez mode. Do not spend 1s -> 2s -> 4s -> 8s retry backoff before paid fallback.
- The probe has a real abort signal and deadline. A `Promise.race` that leaves fetches running without cleanup is not acceptable.
- The paid model chain, prompts, temperature, token caps, parsing, and quality guards remain unchanged except where this spec explicitly aligns Batch with sync safety.
- A free failure must never mark the video ERROR if paid succeeds.
- A late free response must never overwrite a paid winner.
- Client abort does not guarantee Google cancels server work. Treat the late operation as ignored; do not start multiple paid fallbacks.

Initial probe budgets, subject to the bounded measurement in section 3:

- text summary/refine: 8 seconds
- one transcription chunk including Files API upload/activation/generation: 30 seconds

If the measured successful free p75 is higher, use `min(p75 * 1.25, 15s)` for text and `min(p75 * 1.25, 45s)` for audio. Record the measured values and final constants in the research report. Do not add configurable env variables unless measurement proves constants are unsuitable.

### Arzon (`cheap`)

For primary transcription chunks, including a one-chunk video:

```text
free project/key + gemini-3.5-flash
  -> success: checkpoint and continue
  -> quota/RESOURCE_EXHAUSTED: submit exactly one uncovered chunk to paid
     gemini-3-flash-preview Batch, persist the job, return to PROCESSING
  -> authenticated cron polls once per tick
  -> success: idempotently merge into transcription-partial.vtt, account at
     Batch rate, remove the pending job, and re-kick from checkpoint
  -> failed/expired: remove the job and re-kick so the chunk can be retried
  -> still pending at four hours: best-effort cancel/cleanup, switch to fast,
     and finish only uncovered work on paid Standard
```

Requirements:

- One Batch job at a time per video. Cheap chunk concurrency is `1`; fast concurrency remains `AI_CHUNK_CONCURRENCY`.
- Never poll Batch in the transcription workflow or an `after()` task. A request only uploads/submits and returns.
- Batch creation is not idempotent. The recovery cron must not re-kick a video while `aiBatchJobs` is non-empty, except that the four-hour paid flip always wins.
- A quota error must propagate to the top workflow catch after successful or failed Batch submission so the job remains `PROCESSING` with `aiQuotaWaiting=true`. The generic chunk fault-tolerance catch must not swallow it into an empty gap.
- Use the server paid `GEMINI_API_KEY` for submit and poll. Do not submit with an owner key unless the collector is also designed to securely resolve the exact same project/key.
- Free and paid keys may belong to different projects. Do not attempt to reuse a Files API resource created under the free project in the paid Batch project.
- A batch result is already paid for when collected. Budget checks must never block merging it into the checkpoint.

### Explicit scope boundary: text-stage Batch

This delivery completes the existing Wave-2c **transcription Batch** design. Cheap summary/refine keeps its current durable behavior:

```text
free gemini-3.5-flash -> quota wait/recover cron -> four-hour paid Standard
```

Durable Batch for summary/refine is out of scope because the current generation workflow has no persisted intermediate prompt/result checkpoint. Do not claim that the entire text-analysis pipeline uses Batch. Designing text-stage Batch requires a separate accepted spec.

### ElevenLabs timing

- Keep the existing final VTT timing-transfer integration and graceful fallback intact.
- Do not enable it with the credential currently written in a tracked planning document. That credential must be treated as compromised.
- Run the Gemini 3.5 timestamp experiment first. Regardless of its result, do not silently change the owner-selected paid Batch model in this delivery.
- A fresh rotated ElevenLabs key may be installed later, only out-of-band and only with explicit approval for the Railway variable change/redeploy.

## 2. Verified current state and traps

These are code-audit findings, not hypotheses. Re-check line numbers because the tree may move.

### Existing useful primitives

- `apps/web/lib/gemini-batch-transcribe.ts`
  - `submitChunkBatch(...)`
  - `collectBatchResult(...)`
- `packages/database/types/metadata.ts`
  - `aiBatchJobs` already exists.
- The ignored/generated `packages/database/dist/types/metadata.d.ts` already mirrors the field in the current working tree. Regenerate only if the normal package build requires it.
- `apps/web/workflows/transcribe.ts`
  - partial VTT loading/saving and checkpoint resume already exist.
- `apps/web/app/api/cron/recover-stale-ai-jobs/route.ts`
  - cheap retry and four-hour paid flip already exist.

### Critical bugs/risks to address

1. `transcribeAudioChunks.processChunk` currently catches all errors and swallows `AiQuotaWaitError` as a missing chunk.
2. The single-chunk shortcut bypasses the chunk worker and partial-resume path.
3. Recovery currently re-kicks cheap quota waits every ~20 minutes; with a pending Batch job this would create duplicate non-idempotent jobs.
4. Re-kick after collection is ignored while `transcriptionStatus` is still `PROCESSING`; set it to `null` first.
5. Collector storage reads must distinguish “partial object does not exist” from a transient read/storage error. Never overwrite a real partial with only the new Batch chunk after a read failure.
6. Batch generation currently allows 65,536 output tokens while sync transcription caps at 24,000, and collection omits the sync runaway repetition guard. Align Batch with sync.
7. A four-hour flip that only clears metadata can leave the remote Batch and Files API object running while paid Standard repeats the chunk.
8. `aiJobStartedAt` survives completion and is reused with `?? now`; a later explicit new Arzon analysis can inherit an old timestamp and immediately flip to paid.
9. `withCostGuard` authorizes budget before running/recording. Do not use that pre-spend authorization to decide whether an already-completed Batch result may be merged.
10. The old exported `transcribeChunkWithBatch` still contains a 30-minute in-process polling loop, although production has no caller.
11. The GitHub Actions recovery workflow is the only current scheduler. Railway does not automatically schedule these Next routes.

## 3. Phase A — timestamp and cost experiment (must run first)

Purpose: determine whether the now-stable `gemini-3.5-flash` can reach the existing ~1–2 second timing quality without a new ElevenLabs call, and calculate whether a future 3.5-Batch/no-Scribe route could be cheaper than 3-Flash-Batch + Scribe.

### Experiment safety

- Do not retranscribe the full two-hour `bbzt2424z6vvy6t` video.
- Use at most 10 minutes total audio, preferably three representative clips (early/middle/late) whose combined duration is <=10 minutes.
- Reuse existing local reference artifacts without calling ElevenLabs again:
  - `apps/web/scripts/scribe-poc/eleven-words.json`
  - `apps/web/scripts/scribe-poc/fixed-eleven-v2.vtt`
  - `apps/web/scripts/scribe-poc/vtt-live.vtt`
- Never print API keys, signed URLs, database URLs, R2 credentials, transcript content containing private data, or the tracked ElevenLabs credential.
- Use the already configured free Gemini project/key. Do not create a new cloud project, enable Vertex billing, or spend paid tokens for this spike.
- Free-tier Gemini content may be used by Google to improve its products. The owner already requested the existing free-first route; do not expand free-tier processing to any new product/data surface beyond the same transcription and summary/refine inputs already in scope.

### Request variants

Run the same selected audio through `gemini-3.5-flash` with:

1. the current production WebVTT prompt/normalizer; and
2. structured segment output requesting speaker, start, end, and text.

The Developer API documentation now demonstrates timestamped structured transcription. Do not assume that example guarantees word-accurate Uzbek timing; measure it.

Vertex `audioTimestamp: true` is a possible later experiment, but it is not authorized here unless valid Vertex credentials already exist and the owner explicitly approves billable Vertex usage. The Developer API does not guarantee that Vertex-only field.

### Metrics

Create a reproducible local benchmark script and a concise report at:

`docs/research/2026-07-11-gemini35-timestamp-cost-ab.md`

Report, for each variant:

- number of evaluated high-confidence anchors/probes;
- mean, median, and p95 absolute timestamp error;
- maximum error;
- monotonic/bounds-valid cue count;
- number retention and important-name/term retention versus the existing Gemini text;
- Uzbek Latin and Russian Cyrillic preservation spot-check;
- input/audio/output token counts;
- wall-clock latency;
- whether the result passes all gates below.

Timestamp acceptance gates for considering a future no-Scribe route:

- mean absolute error <=2.0 seconds;
- p95 absolute error <=5.0 seconds;
- no non-monotonic or out-of-audio-bound cues;
- number/important-term retention is not lower than the current Gemini transcript;
- no measurable Cyrillic regression.

Use the existing Scribe-transferred VTT as a practical reference, but label that it is not an independent human ground truth. Reuse the existing high-confidence grid probes where possible.

### Cost comparison

Use actual measured tokens and current official prices, not the stale estimator:

- `gemini-3-flash-preview` Batch: $0.50/M audio input, $0.25/M text input, $1.50/M output;
- `gemini-3.5-flash` Batch: $0.75/M input, $4.50/M output;
- ElevenLabs Scribe: project assumption $0.22/hour.

Compare:

```text
A: paid Gemini 3 Flash Batch + $0.22/hour Scribe timing
B: paid Gemini 3.5 Flash Batch without Scribe (only if timestamp gates pass)
```

Do not change production routing to B in this delivery. Record the measured break-even and recommendation for the owner.

If Gemini 3.5 fails the timing gates, state the conclusion plainly: keep Scribe for long videos; do not ship a weaker free retimer. Continue with Phases B–E.

Official references:

- Gemini audio: https://ai.google.dev/gemini-api/docs/audio
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Batch API: https://ai.google.dev/gemini-api/docs/batch-api
- Context caching: https://ai.google.dev/gemini-api/docs/caching
- Model lifecycle: https://ai.google.dev/gemini-api/docs/models

## 4. Phase B — bounded Tez free probe

### Implementation shape

Add the smallest reusable deadline helper justified by the two call sites. It must:

- create/accept an `AbortController`;
- abort once at deadline;
- clear its timer in `finally`;
- expose a recognizable deadline error;
- never invoke the fallback itself.

Extend Gemini call plumbing surgically:

- `transcribeWithGemini` accepts an optional `AbortSignal` and retry-attempt override.
- Every fetch in that operation uses the signal: source download, Files API init/upload/poll, generation.
- File cleanup runs best-effort in `finally` with a fresh cleanup request even when the main signal is aborted.
- Any poll sleep must wake/abort promptly.
- `callAiApiWithModel` accepts an optional signal and retry-attempt override.
- In Tez free calls only: `maxAttempts=1` plus the measured deadline.
- Cheap free behavior and all paid retries remain unchanged unless required by Phase C quota propagation.

Do not implement a free/paid race. Racing can charge paid even when free later succeeds. The owner asked for free-first with a short bounded delay, not speculative double execution.

### Required tests

Extend focused free-tier tests to prove:

- fast free success returns free and never calls paid;
- fast free 429 makes one free attempt, no backoff, then calls paid once;
- fast free deadline aborts and calls paid once;
- late free completion cannot overwrite paid output;
- paid failure still follows the existing paid fallback/error behavior;
- cheap quota behavior remains a quota wait, not fast fallback;
- no free key means byte-for-byte-equivalent paid-only routing.

Use fake timers and injected/mocked fetches; tests must not wait real seconds.

## 5. Phase C — durable one-at-a-time transcription Batch

### C1. Batch helper hardening

In `apps/web/lib/gemini-batch-transcribe.ts`:

- keep `BATCH_TRANSCRIBE_MODEL` pinned to `gemini-3-flash-preview` for this delivery;
- align `maxOutputTokens` with sync transcription’s 24,000 cap;
- apply the same runaway-repetition guard before normalizing the collected raw text;
- if upload succeeds but Batch submission fails, best-effort delete the uploaded Files API object;
- export small best-effort cancel/delete helpers needed by paid continuation;
- remove the obsolete exported in-process orchestration (`transcribeChunkWithBatch`) and its 30-minute polling path if it has no production callers; keep useful pure state/response parsing helpers;
- never log signed URLs or secrets.

### C2. Submit on cheap quota

In `apps/web/workflows/transcribe.ts`:

- cheap primary chunk concurrency is `1`; fast remains unchanged;
- before generic chunk fault tolerance, catch `AiQuotaWaitError` in cheap mode;
- if no pending job exists for the video/chunk, submit one paid Batch job;
- persist `{batchName,fileName,startSec,durationSec,submittedAt}` with a fresh read-modify-write so unrelated metadata is retained;
- after persistence, rethrow the quota wait;
- if submission fails, log safely and rethrow the original quota wait so the patient-free retry remains available;
- handle the single-chunk path explicitly: it must submit on quota and, after collection, recognize/reuse the partial checkpoint rather than retranscribing the full chunk;
- ensure cleanup does not delete audio before the paid Batch upload/submit has completed.

Gap-fill spans are exceptional but still part of transcription. Preferred behavior is to use the same one-at-a-time submission path for a cheap quota failure, persisting the span’s absolute `startSec` and `durationSec`. If this cannot be made safe without broad redesign, preserve durable free retry and document this exact deviation; do not silently fall through to paid Standard in cheap mode.

### C3. New collector cron

Create:

`apps/web/app/api/cron/poll-batch-jobs/route.ts`

It must:

- use `force-dynamic`;
- use the same timing-safe `Bearer CRON_SECRET` authentication pattern as the recovery route;
- select non-deleted videos with non-empty `metadata.aiBatchJobs`;
- use the same server paid key used for submission;
- poll each stored job once per invocation;
- keep pending jobs untouched;
- on terminal failure/expiry, remove the job and prepare a cheap re-kick;
- on success, strictly read the current partial VTT, idempotently merge the result at `startSec`, write the checkpoint, record Batch usage best-effort, remove the job, then prepare a cheap re-kick;
- if the video is no longer cheap, best-effort cancel/cleanup and clear stray jobs;
- before re-kick, set `transcriptionStatus:null`, clear stale processing markers as appropriate, retain the original `aiJobStartedAt`, and call `transcribeVideo(..., "cheap")`;
- isolate failures per video so one bad job does not abort the entire cron response;
- return counts for pending/succeeded/failed/retried/errors without exposing identifiers or secrets unnecessarily.

Storage safety:

- Missing `transcription-partial.vtt` means an empty `WEBVTT` base.
- Any other storage/read failure means keep the job and retry next cron tick.
- Never overwrite a partial after an ambiguous read failure.

Idempotency:

- Add a pure, focused merge path that drops a Batch cue already present with the same absolute timing and normalized text. Do not broadly change normal transcript merge behavior.
- Make usage accounting idempotent per `batchName`, preferably with a deterministic `ai_usage_events.id` and duplicate-key no-op.
- Accounting failure must not discard or block an already-paid transcript result.

### C4. Recovery interaction

In `recover-stale-ai-jobs`:

1. Check the four-hour paid flip first.
2. If not flipping and `aiBatchJobs` is non-empty, skip the normal stale re-kick because the collector owns it.
3. Otherwise retain existing recovery behavior.

The four-hour check must remain first; otherwise a permanently pending Batch job never reaches the paid ceiling.

### C5. Manual/automatic paid continuation

In `continueAiJobOnPaid`:

- read pending jobs;
- best-effort cancel their Batch jobs and delete Files API objects using the paid server key;
- never let cleanup failure prevent the fast continuation;
- set `aiBatchJobs:undefined`;
- retain the partial transcript already collected;
- reset only processing/wait markers needed for the new paid continuation.

### C6. Job-start lifecycle

Fix the stale `aiJobStartedAt` bug without changing retry semantics:

- a genuinely new owner-triggered AI analysis/re-analysis gets a fresh timestamp;
- an automatic retry, Batch collection re-kick, or manual paid continuation preserves the current job’s original timestamp until it intentionally switches mode;
- successful terminal AI generation clears the timestamp, or the next explicit user start unconditionally replaces it;
- add a pure helper/test if needed so “new job” versus “retry” is explicit, not inferred from wall-clock guesses.

## 6. Phase D — schedule and accurate accounting

### Schedule

Update `.github/workflows/recover-cron.yml` to call the new collector route on the same 30-minute schedule, with a separate output file and HTTP status check. Keep the existing health and recovery calls.

Do not add a fake Railway schedule to `railway.json`; Railway does not derive cron invocations from that app service file.

Check secret presence only with commands that do not reveal values. If the GitHub `CRON_SECRET` secret is absent, report the owner action; do not print/copy it into logs or docs.

### Pricing

Update the local pricing table and tests using current official rates:

- `gemini-3-flash-preview`: text input $0.50/M, audio input $1.00/M, output $3.00/M;
- `gemini-3.5-flash`: input $1.50/M for text/audio, output $9.00/M;
- `gemini-2.5-flash`: keep its current official rates;
- Batch remains the existing 0.5 multiplier.

Free calls still record $0 through `free:true`. Do not misrepresent a paid fallback as free.

The `gemini-flash-latest` alias now points at 3.5 and may change again. Do not use it for a cost-sensitive primary decision. Keep the explicitly pinned 3 Flash primary; any fallback alias accounting limitation must be documented if not fixed surgically.

## 7. Phase E — ElevenLabs credential safety and optional enablement

A tracked planning document contains a literal ElevenLabs credential. Never quote it in terminal output, chat, commit messages, patches, or logs.

Required local safety edit:

- replace the literal value in `docs/plans/2026-07-08-scribe-timing-transfer.md` with a placeholder such as `<ROTATED_KEY_SET_OUT_OF_BAND>`;
- search tracked files for additional ElevenLabs credential values by filename-only output;
- do not rewrite Git history in this task;
- add the optional `ELEVENLABS_API_KEY` variable to `.env.example`/Railway env documentation if missing, with no value.

Operational blocker:

- The exposed key must be revoked/rotated in the owner’s ElevenLabs account.
- Do not set the old key on Railway.
- Setting a new Railway variable can trigger a redeploy and therefore requires explicit owner approval at execution time.
- If the owner provides a fresh key out-of-band and explicitly approves the env change, set it without echoing it and then verify only that the variable is present—not its value.

If the Gemini 3.5 experiment passes, still leave the safe optional Scribe fallback available in code. The owner will decide later whether to switch the paid Batch model/timing architecture after reviewing the measured cost table.

## 8. Expected file surface

The exact test file split may vary, but every changed production file must trace to this spec. Expected files include:

- `apps/web/workflows/transcribe.ts`
- `apps/web/workflows/generate-ai.ts`
- `apps/web/lib/gemini-transcribe.ts`
- `apps/web/lib/gemini-batch-transcribe.ts`
- `apps/web/lib/gemini-retry.ts` only if required for signal/attempt plumbing
- one small deadline helper only if genuinely shared
- `apps/web/lib/ai-job-control.ts`
- `apps/web/lib/ai-cost-guard.ts` only for idempotent post-spend Batch recording
- `apps/web/app/api/cron/poll-batch-jobs/route.ts`
- `apps/web/app/api/cron/recover-stale-ai-jobs/route.ts`
- `.github/workflows/recover-cron.yml`
- `packages/utils/src/ai-pricing.ts` and its test
- focused existing/new Vitest files
- `docs/research/2026-07-11-gemini35-timestamp-cost-ab.md`
- optional reproducible benchmark script
- env documentation and the secret-redaction line
- `docs/STATE.md` only after implementation and gates are complete

If a file is not required by one of these behaviors, do not touch it.

## 9. Required focused tests

At minimum, cover:

1. Tez transcription free success.
2. Tez transcription free quota -> exactly one free call -> paid.
3. Tez transcription free timeout/abort -> paid once.
4. Tez summary/refine free success/quota/timeout routing.
5. Cheap quota -> exactly one Batch submit -> metadata persisted -> quota wait rethrown.
6. Cheap concurrency is one; fast concurrency unchanged.
7. Single-chunk cheap submit and collected-checkpoint reuse.
8. Batch submit failure cleans Files API input best-effort and preserves patient wait.
9. Batch collection pending -> keep.
10. Batch collection success -> strict read -> idempotent merge -> idempotent accounting -> drop -> status reset -> cheap re-kick.
11. Batch collection failure -> drop -> status reset -> cheap re-kick.
12. Storage read failure -> no overwrite, no drop.
13. Recovery skips pending Batch before four hours.
14. Recovery still flips pending Batch after four hours.
15. Paid continuation clears/cancels Batch and preserves partial.
16. Explicit new job resets stale `aiJobStartedAt`; retries preserve it.
17. Batch uses the 24k output cap and runaway guard.
18. Updated pricing and Batch 0.5 calculation.

Tests must fail if the respective behavior is removed. Do not weaken existing assertions or add always-pass scripts.

## 10. Verification gates

Run a baseline of the focused suites before editing where practical. After implementation, run from repo root:

```powershell
pnpm --filter @cap/web exec tsc --noEmit
pnpm --filter @cap/web run test
pnpm --filter @cap/web build
pnpm --filter @cap/utils exec vitest run src/ai-pricing.test.ts
git diff --stat
git diff --stat -w --ignore-cr-at-eol
```

The two diff stats must not reveal whole-file line-ending or formatting churn. Inspect every touched file and revert only your own unrelated changes. Do not disturb pre-existing untracked files.

Do not report “done” unless typecheck, relevant Vitest suites, production build, and diff audit pass. If a machine/resource failure blocks a gate, report the exact command and failure honestly; do not substitute a weaker check.

## 11. Completion report and STATE handoff

After gates:

- update only the TOP/current block of `docs/STATE.md` with:
  - timestamp experiment result and measured numbers;
  - exact Tez deadlines;
  - durable Batch behavior and cron route;
  - remaining owner actions (fresh ElevenLabs key, CRON secret if absent, review/deploy approval);
  - test/build results;
  - “LOCAL ONLY — NOT PUSHED/DEPLOYED”.
- list every changed file and why it was required;
- confirm no in-process Batch polling remains;
- confirm no secret value appears in the diff;
- confirm no push/deploy/env mutation occurred;
- state clearly that summary/refine Batch is not part of this delivery;
- include `git diff --stat` and gate pass counts.

Stop with the local verified diff ready for owner review. Do not push the `qa-fixes` branch: push auto-deploys Railway.
