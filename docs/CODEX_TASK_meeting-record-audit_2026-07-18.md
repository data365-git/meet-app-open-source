# Codex task — audit the heart: "a meeting must NEVER fail to record"

> Owner: paste everything below the line into Codex, in this repo. Nothing else needed.
> A Fable audit of the same question is running in parallel and has NOT seen this file —
> the two must stay independent. If both converge on the same defect, trust it.

---

Repo: `D:\vibecoding\ustoz-github`, branch `qa-fixes`, HEAD `0327eea`.
**READ-ONLY. Do not edit, stage, commit or push anything.** You may run tests and read-only commands.

## Your job: try to REFUTE a guarantee

This is a self-hosted Google Meet recorder for a small company. The owner's requirement above all others: **a meeting must NEVER fail to record.** He calls it the heart of the project.

Your job is NOT to summarise the code or confirm it looks fine. It is to **break the guarantee**. Default to "this is broken and I will prove it." An honest "I could not break it, here is exactly what I tried" is valuable. A vague "looks sound" is worthless and will be treated as a failed audit.

The guarantee has two halves:

- **(A) SAVE** — once recording starts, every captured byte reaches storage and the recording finalizes into a playable video. No silent truncation, no silent hole, no stranded multipart upload, no state stuck forever.
- **(B) CONTENT** — the recording actually contains what a meeting recording must contain: the screen AND the other participants' voices, not just the local mic. A file that plays but is silent where the client spoke is a FAILURE of this guarantee, not a minor UX issue.

## Why this audit exists — this shapes where to look

This guarantee has been audited and declared safe before, twice, while broken:

1. An earlier audit blessed the code while the extension was failing EVERY recording over ~2-3 minutes in production, for about 10 days. Cause: R2 requires all multipart parts except the last to be equal size; the extension flushed its whole buffer whenever it crossed 5 MiB. The identical bug had already been fixed in the WEB uploader and was missed here, because the two packages share no code — so no reference search linked them. **Lesson: ask "who else does this same job?", not "who calls this function?"**
2. Today the owner ran a real Meet and the other participant's voice was missing. There was a "guaranteed client audio" design whose flag lived in volatile service-worker state and was destroyed by an ordinary picker-cancel-then-retry. Silent downgrade to mic-only. Fixed in `0327eea` — audit that fix too, it is hours old.
3. Also today, three of five parallel work streams reported "fixed" for defects they had not fixed.

So: treat reassuring comments as claims to verify, not facts. Several comments in this codebase describe fail-closed behaviour the implementation does not actually have.

## Scope

Primary: `apps/browser-extension/src/` — especially `background/upload.ts`, `background/sw.ts`, `background/state.ts`, `offscreen/recorder.ts`, `recorder/recorder-page.ts`.
Secondary: `apps/web/app/api/upload/[...route]/multipart.ts` (server-side completion).

Recent commits to audit against — several written today, do not assume they are correct:
- `0327eea` — meeting audio guarantee moved from volatile SW state into recorder-tab URL params; `recorderTabId` fallback; page no longer trusts only the SW echo.
- `c7efcda` — queued retry bytes counted toward startup viability; idempotent completion on `NoSuchUpload`.

## Known and ACCEPTED — do not re-report these

- **R3** — a browser process CRASH at the exact instant of an in-flight ~5 MiB slice loses that slice. Owner accepted, documented.
- **R5** — a single recording above ~48 GiB / 10,000 parts fails. Owner accepted; no meeting reaches it.
- **H5** — the server trusts client-declared sizes for quota (`storedBytes` is only read for `isRawRecorderUpload`, and the extension sends `result.mp4`, so the extension quota hole is open). Known, deliberately not fixed.
- The extension has ~53 pre-existing tsc errors and is not tsc-gated in CI. Known.

## Attack list — go beyond it if you see something better

1. **Concurrency and scheduling.** A previous bug here came from making a startup-only path periodic: untouched code became unsafe because something else could now be in flight. Re-audit every retry/alarm/drain path asking "what else can be alive at the same time?" Look for read → await → write-back stale-snapshot clobbers, and two writers of the same part number or state key.
2. **Lifetime.** The meeting guarantee just moved into URL params because volatile state was destroying it. What ELSE that matters lives only in service-worker state or one tab's memory — and which ordinary user gesture destroys it? Enumerate every message that clears or rewrites state and ask which a user can trigger mid-recording.
3. **The part list.** Can a gap, duplicate, out-of-order part number, or unequal-size non-final part still reach `completeMultipart`? Trace the remainder/flush logic and its interaction with the dead-letter store.
4. **Completion.** Can a recording end in a state that never completes and never reports an error — stuck "recording"/"uploading" forever? Can a user action (e.g. CANCEL from a confusing state) destroy already-uploaded bytes? Follow what the UI actually offers at each state.
5. **Content, not just bytes.** Under what reachable conditions does a recording end WITHOUT remote audio, or without video, while still reporting success? Include: tab audio track ends or mutes mid-meeting, mic permission denied, user picks the wrong surface, Meet tab closed and reopened.
6. **Twins.** For each defect class, ask who else does that same job — the offscreen recorder, the recorder page, the web recorder, the server. Report twins even when the primary site is clean.

## Method

Prefer executable proof. Extension suite: `pnpm --filter @cap/browser-extension run test` (33 tests). Where a defect can be demonstrated with a scratch test, write it in a TEMP directory outside the repo and quote the output. Where it cannot, give the exact user action sequence plus file:line reasoning.

## Output

For each finding: severity (**CRITICAL** = a meeting is lost or silently incomplete / MAJOR / MINOR), the precise user-reachable scenario, file:line evidence, and whether you **PROVED** or **INFERRED** it. Keep those two apart — do not let an inference wear the costume of a proof.

Then explicitly:
- What you tried to break and **could not**. This is what tells the owner where real confidence lives.
- What genuinely cannot be settled without a real device, and the smallest device test for each.
- Verdict on each half: is **(A) SAVE** sound? is **(B) CONTENT** sound?

The owner is a non-programmer. End with a plain-language bottom line: can he hand this to his team — yes or no — and what is the single biggest remaining risk.
