# Ustoz (Cap fork) — Project STATE

_Trigger words: "ustoz", "cap", "cap-v2". Source of truth for resume._

---
## 🚨 PRODUCTION IS DEGRADED RIGHT NOW — GEMINI CREDITS ARE DEPLETED (2026-07-20 ~14:20)

**Every AI feature on prod is down: transcription, summaries, chapters, tasks, chat.** Not a rate limit — the API answers with `429: "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing."` A meeting recorded today will upload and play fine, and then fail to transcribe. The free key cannot cover for it: it has its own **daily cap of ~20 calls**, already spent that day — see the correction below, which proves the free tier genuinely works within that cap. **Do not read this block as "free is dead" and delete the free path.**

**OWNER ACTION (only he can): top up the Gemini project's billing at https://ai.studio/projects.** He confirmed on 2026-07-20 evening: *"GEMINI KREDIT YO'Q ERTAGA OLAMIZ"* — **credit is being bought the next day (2026-07-21)**. Until then, do not chase transcription bugs: everything fails for this one reason, and a session could easily burn hours on it.

**▶ OWNER'S INSTRUCTION (2026-07-20 evening): do NOT start automatically — he will say when. Tomorrow's first act is to CHECK whether credit has arrived, then wait for his word before spending any of it.**

**▶ WHEN HE SAYS GO, run this measurement ladder — one re-transcription per step, in this order, keeping whichever step actually helps:**
1. **Baseline** — re-transcribe `fm3pz7yref328m7` (53 min) as-is and run `node /tmp/measure-transcript-drift.mjs fm3pz7yref328m7 12 20`. This also verifies the already-deployed anchor fix (`13dfa48`), which has never been measured. Last known: max 28.6s, mean 10.2s.
2. **3-minute chunks** — apply `docs/plans/2026-07-20-shorter-chunks-ready-to-apply.md` (two constants), re-measure. Expected mean 5-7s. ⚠️ Also time the run: chunks are processed 3-at-a-time (`AI_CHUNK_CONCURRENCY = 3`), so 18 chunks means 6 waves instead of 3 — whether that is slower depends on per-call latency, which has NEVER been measured. If it is 2x slower for no accuracy gain, revert.
3. **Retime port** — port `warp4.mjs` to `apps/web/lib/vtt-retime.ts` per its own spec (both in `docs/plans/recovered-retime-prototype/`), re-measure. This is the only step that attacks the CURVATURE the linear rescale leaves behind.

Note the rig now prints its own uncertainty (`±stderr` and `weakest_match`) — **a difference smaller than ~2 SE is not a result**, so do not report one.

**⚠️ CORRECTED 2026-07-20 evening — the paragraph below was half-wrong; read the correction FIRST.** The free tier is neither dead nor a workaround: it is **real but capped at ~20 calls/day**. Proof from the prod DB, not from logs:
```
SELECT operation, model, COUNT(*), SUM(costUsdMicros=0) FROM ai_usage_events WHERE videoId='fm3pz7yref328m7' GROUP BY 1,2;
  transcription  gemini-3.5-flash  20 rows  ALL $0     <- free audio transcription DID work, 20×
  summary        gemini-3.5-flash   8 rows  ALL $0
```
Daily totals show the same shape (07-19: 17 free calls, 07-11: 24). Directly measured the same evening: the **Files API upload on the free key succeeds** (1.4 MB / 6-min chunk → uploaded + ACTIVE in **3.3s**), so "the upload bucket is exhausted" was a symptom of that day's quota, not a permanent property. Audio `generateContent` on free then returned **503 UNAVAILABLE** 4/4 (one hanging 74s) — capacity, not quota.
**So the real defect is NOT "free never works".** It is: once the daily ~20 is spent, the code still burns the full 30 s probe on **every remaining chunk** before falling back to paid (7/7 chunks on the 07-20 run). The fix is one surgical change — remember the quota-exhausted signal and stop probing for the rest of the run — **not** deleting the free path, which would destroy a saving that is genuinely happening. Also measured: `gemini-3.5-flash` free quota is `quotaValue: 20` per model per day (from the 429 body); `gemini-3-flash-preview` still answered on the free key while 3.5 was exhausted, so switching the free model id may buy more headroom — **unverified, needs the owner's rate-limit page.**

**Also corrected 2026-07-20 (owner-measured): prod DOES auto-migrate on boot.** Logs show `DB migrations triggered → Running DB migrations`, and an already-present column logs `Migration error is benign (ER_DUP_FIELDNAME)`. The older lines at ~1587/1606 saying *"deploy auto-migrate QILMAYDI — qo'lda CREATE TABLE qildim"* are left in place as history, but they are **no longer true of today's deploy** — and they already cost real work: an adversarial plan review ranked a non-existent "total AI outage from a missing column" as its #1 blocker on the strength of them. Verify against a live boot log before trusting either claim.

**(superseded, kept for the trail) "No free-tier workaround exists — this was TESTED, so don't re-try it."** The free key is not uniformly dead: a direct `generateContent` call returns **HTTP 200**, which makes it look like a usable fallback. It is not, because transcription needs the **Files API** to upload audio first, and that bucket IS exhausted: forcing a run with `{"speedMode":"cheap"}` (the patient free path) produced `cheap-mode Batch submit failed … Gemini upload init failed (HTTP 429)`. The video parked correctly in `PROCESSING` + `aiQuotaWaiting` and will resume by itself when quota returns — that part of the design works. Text generation on free ≠ audio transcription on free.

**✅ THE FAILURE PATH IS NOW FIXED — committed `bbf3ae2`, unit-proven, NOT live-verified.** A parallel session finished it and ended without committing; the work was reviewed (gate exit 0, its 19 tests pass) and committed here so a stray checkout could not lose it. What it does: `transcriptionError.code` distinguishes **QUOTA** (out of credit / rate-limited — transient) from **FAILED** (a real failure); QUOTA is re-kicked by `recover-stale-ai-jobs` with a **backoff** (`quotaRetryNextAt`) rather than a flat attempt cap — an adversarial review caught that a flat 5-attempt cap burns out ~2.5 hours after the failure while credits are topped up the NEXT DAY, so nothing would ever have self-recovered; and the share page now says something true and audience-specific in three languages (owner: "your recording is safe, the AI account needs topping up"; public viewer: the calm version). ⚠️ **Neither branch has run against the real API** — every Gemini call is 429 — so re-verify the auto-retry once billing is restored.

**(historic) The same fix was designed earlier in the day and deliberately NOT shipped** (then spawned as its own task). Today the pipeline throws a generic `All N transcription chunks failed`, the video lands in `ERROR`, nothing resumes it when billing returns, and recovery meant flipping `transcriptionStatus` by hand in MySQL. It should instead name the cause, keep the recording obviously safe, and offer a retry. The reason it was not shipped mid-incident: **it is a change to the failure path, and with every Gemini call returning 429 there was no way to verify either branch.** Shipping unverifiable changes to the recovery path of the core feature, during an outage of that feature, is how a bad day becomes a worse one. Note for whoever picks it up: reusing `AiQuotaWaitError` in fast mode is a trap — cheap mode can park safely only because it has already submitted a durable Batch that a cron collects; fast mode would strand the video in PROCESSING forever.

How it was found: the run that would have verified the drift anchor fix failed with `All 9 transcription chunks failed … HTTP 429`. The honest part: **four re-transcriptions of a 53-minute video in one afternoon (mine, verifying the drift fix) contributed to draining it** — this month's AI spend moved 59 760 → 68 400 so'm during the session. A verification loop that re-runs a paid pipeline needs a budget check before the first run, not after the fourth. See also the free-tier finding below: with the free tier broken on both paths, every one of those runs billed the paid account.

---
## ❓ OPEN DECISION — TRANSCRIPT TIMING: pay for Scribe, or live with ~10s? (asked 2026-07-20, NOT yet answered)

The owner asked two things at the end of the session; here is what was established, so the question can be re-asked in one line instead of re-researched.

**Where free (Gemini-only) timing stands today, measured:** 52-minute meeting → **mean ~10s, max 28.6s**, systematic bias gone (−4.3s). For scale, the 2026-07-08 investigation on a 2-hour video reached **~11s mean** by a completely different free method (pause-reinsertion retime) and concluded transcript-only methods bottom out there, because Gemini's output carries almost no timing structure. ⚠️ The two numbers come from **different videos and different measuring rigs** — treat it as "same order of magnitude", not a like-for-like comparison.

**The paid alternative already EXISTS in the product and is wired end-to-end:** the "Timestampni aniqlashtirish" button (`apps/web/actions/video/refine-timestamps.ts`, `lib/eleven-scribe.ts`, strings at `messages/uz.json:183-190`). It keeps Gemini's TEXT and replaces only the TIMINGS via ElevenLabs Scribe v2 — measured at **~3s** on the 2h video in July. Per-video and opt-in, so it costs only for recordings whose timing actually matters: **~$0.22 per audio hour** (a 52-min meeting ≈ $0.19).

**But it cannot be used right now: `ELEVENLABS_API_KEY` is NOT set on the prod container** (verified by `printenv` — empty). The button therefore answers "Scribe hali serverga ulanmagan". **To enable: owner supplies an ElevenLabs API key → set it in Coolify → redeploy.**

**✅ THE REVIEW CAME BACK — full text saved at `docs/plans/2026-07-20-free-timing-ceiling-review.md`. Read it before touching timing again; it is ~90k tokens of work and it changes the plan.** Verdict: **not the free ceiling, but the free headroom is ~2×, not ~10×.** Its three load-bearing points:
1. **Do 3-minute chunks first** (`LONG_AUDIO_CHUNK_DURATION_SEC` 360→180 in `workflows/transcribe.ts:113`). One linear stretch cannot remove a *curved* clock, only its average slope; halving the span caps the leftover curvature. Plausibly **mean 10→5-7s, max 28→12-15s — i.e. the ≤15s target, for ~$0.40 and 1-2 hours.**
2. **⚠️ The measuring rig is now a limiting factor.** Cue-start quantization alone is ±2-5s, weak matches (score 0.33, threshold 0.25) can be off by ~10s, and the standard error of a 12-sample mean is ~2.3s. **So "10s vs 7s" is not a distinguishable difference today, and the max=28.6s rests on the least trustworthy sample in the run.** Calibrate first (~30 min): run the rig against the bbzt Scribe VTT whose true error is ~1-2s — whatever it reports there IS the instrument's noise floor.
3. **A free path to ~3-5s exists and was never built:** grid-probe piecewise warp (turn the measuring rig into a correcting one, ~$0.05-0.10/hour, ~1 day, reuses the July `grid-localize.mjs`/`transfer.mjs`). Scribe stays the proven 1-2s answer at $0.22/hour.

**The decision for the owner:** (a) accept ~10s free, (b) supply an ElevenLabs key and refine per-video at ~$0.22/hour, or (c) spend ~2 more hours on 3-minute chunks first — which may reach the target for pennies and does not close off (b).

**Honest caveat to carry into that decision:** for the fast multi-speaker CARD ui, the 07-08 analysis showed even **3s** of drift lands on the wrong 4s card **38%** of the time. If the requirement is "the highlighted card is always right", no free transcript-side method gets there — only the grid-probe warp or Scribe.

**✅ THE JULY RETIME PROTOTYPE IS RECOVERED — `docs/plans/recovered-retime-prototype/` (34 files, commit `d0c922b`).** It was believed lost: the scratchpad that held it was emptied on 2026-07-15 and nothing had been committed. It came back out of the SESSION TRANSCRIPT — Claude Code keeps every session as JSONL under `C:\Users\mirko\.claude\projects\D--vibecoding\<session-id>.jsonl`, and a `Write` tool call contains the whole file. Method, reusable for any "lost" scratchpad: grep the transcript for a distinctive string, then walk the JSON for `tool_use` blocks whose `input.file_path` matches and dump `input.content` (keep the longest version = the final edit).
What is in it: `warp4.mjs` (the pause-reinsertion algorithm), `warp.mjs`/`warp2`/`warp3` (the three approaches that FAILED first — silence-envelope, onset-impulse, Viterbi — so nobody re-tries them), `retime-spec.md` (the production-port spec, algorithm declared frozen), `grid-localize.mjs` (the ground-truth rig behind the 18.3s→10.8s number), plus the diagnostics that proved Gemini compresses SPEECH, not only pauses. ⚠️ They hard-code the old scratchpad path and that one video's constants — take the ALGORITHM, not the scripts.
Two facts the hunt also settled: part of the July work WAS already tracked at `apps/web/scripts/scribe-poc/` (grid-localize, transfer-dp + data), and `apps/web/lib/vtt-retime.ts` **does not exist anywhere on the machine** — the production port was specced but never done.

**THE INSIGHT WORTH ACTING ON:** today's shipped rescale is **linear** (one factor per chunk — fixes the average slope); the July retime is **non-uniform** (silences absorb the missing time, speech keeps slope 1 — fixes the shape). Each reached ~10s ALONE. **Whether they compose has never been measured** — the July team had no rescale, and today's work did not have this. Measure in this order once credits return: ① current ② + 3-minute chunks (`docs/plans/2026-07-20-shorter-chunks-ready-to-apply.md`) ③ + retime port.

**State of the tree (2026-07-20 ~17:00):** everything is committed and pushed to `qa-fixes`, HEAD **`bbf3ae2`** (38 commits this session, including a parallel session's quota work that was rescued from an uncommitted state). `git status` shows **100 untracked files and 1 modified** — none of them are this session's work: they are long-standing leftovers (old `CODEX_TO_CLAUDE_*.md` handoffs, `docs/qa/**` reports, scratchpad dirs) that predate it. Do not "tidy" them blindly; each is someone's old evidence.

---
## ⏩ NEXT SESSION — START HERE (written 2026-07-20, session o)

🎯 **GOAL unchanged:** production-ready for the owner's IT team. #1 = a meeting must never fail to record, and the recording must contain the OTHER participants' voices.

**✅ #1 IS MET** (owner, real Meet, 2026-07-19: *"mijoz ovozi yozildi"*, filed under Meetings).

**✅ THE TWO-STEP IN-PAGE FLOW IS BUILT AND MACHINE-PROVEN (2026-07-20).** Meet sahifasidagi **"Record now"** → screen picker → done. Two actions, and the remote voices no longer depend on `activeTab`/`tabCapture` at all: they are tapped from Meet's own media elements with `HTMLMediaElement.captureStream()`.
- Code: `apps/browser-extension/src/content/inpage-recorder.ts` (new) + `content/meet-detect.ts` (wiring). Extension **v0.5.0**. The `Ctrl+Shift+9` path is untouched and still works as the fallback.
- Proof: `e2e-audio-proof/run-proof-inpage.mjs` — VERDICT=PASS ×2 (and again on the final build, all 4 segments −16.6 dB with the source-swap variant), tone above threshold, filing=meeting, duration OK.
- **The SHORTCUT path (Ctrl+Shift+9) is now proven up to the screen picker; the harness keystroke was the problem and is FIXED (`a1d890b`).** WScript SendKeys reported success while the chord went to whatever window held the foreground — a harness lie that read as `recorder-tab-never-opened`, i.e. "the product broke". `send-shortcut.ps1` now claims the foreground properly (AttachThreadInput + an ALT tap, which Windows requires before honouring SetForegroundWindow from automation) and reports `sent-foreground-ok`. With that, the proof gets three stages further and confirms: keystroke → `chrome.commands` → the SW opens the recorder tab with the right params → the Boshlash click reaches `startRecording` (`btn-start disabled after click: true`, a check added to separate "click never landed" from "something after it hangs"). **What is still unproven is only the last stage: the screen picker is not auto-accepted in the recorder-page context, so `getDisplayMedia` never resolves.** Note the in-page proof auto-accepts fine with the same flag, so the difference is that context, not the flag.
- (historic) The original diagnosis of that FAIL: Three separate checks say the product is fine: the same FAIL reproduces on a **stashed, unmodified tree**; `chrome.commands.getAll()` in a fresh profile returns `start-meeting-recording: Ctrl+Shift+9`, so the command IS registered; and nothing in this session touches that path (the content script is the in-page recorder's; the two SW additions are both scoped to `contentRecorderTabId`). An attempt to drive it without a keystroke also failed for a harness reason worth knowing: **`chrome.runtime.sendMessage` from inside the service worker does NOT reach that worker's own `onMessage` listener**, so a START_INSTRUCTION cannot be simulated from there. The owner's QA script names this path as the fallback, so his run covers it.
- Two real bugs it caught, both fixed: the content script's copy-pasted meeting-id regex kept a LEADING SLASH (so `MEET_CALL_ENDED` never matched a shortcut-path recording → the meeting-ended prompt silently never fired); and `getUserMedia` hanging on Chrome's mic prompt froze the start on "Boshlanmoqda…" (mic is now best-effort, 8s deadline).

**✅ INDEPENDENT REVIEW ROUND DONE (Fable, non-author) — 7 defects found, all fixed in `4cc00ca`.** Three were BLOCKERs and none were hypothetical:
1. **Meet tab RELOAD** mid-recording left the SW stuck in "recording" forever (beforeunload's `recorder.stop()` never runs its handlers in a dying document; `tabs.onRemoved` does not fire on reload; the URL watcher only reacts to URL *changes*). Everything after the reload went unrecorded while the badge said REC and a restart was refused. → SW now finalizes on `status==="loading"` for the recording's own content tab.
2. **Doubled/echoing audio**: start alone → picker system audio is mixed as a stand-in; the client joins → their voice is tapped AND still coming through the loopback. → system audio now has its own gain node, muted the instant a real tap attaches.
3. **The subtle one — Meet REUSES its media elements and swaps the source.** A `MediaStreamAudioSourceNode` is bound to the track it was built from, so taps went silent while still looking connected. My first fix (prune streams with no live track) was WRONG and the harness proved it: segments 3–4 at **−90 dB, digital silence**. Real fix = compare the bound TRACK ID to the element's current live track and rebuild on drift. Re-measured: all 4 segments at a steady **−16.6 dB**. Run it with `PROOF_SWAP=1 node run-proof-inpage.mjs`.
Also fixed: stale `arming` after declining the confirm (new sender-scoped `MEET_NUDGE_CANCEL`), watchdog warnings written into a DOM-detached card (invisible), a leaked mic stream after the 8s timeout, "Stop sharing" missed during the start window, `pickMimeType` hoisted out of THREE copies, idempotent PAUSE/RESUME acks.
**Known debt, deliberately unpaid:** the chunk-streaming machinery is still duplicated across the three recorder paths (recorder page / offscreen / in-page). Next time one of them changes, hoist it.

**Deployed 2026-07-20:** commit `4cc00ca` (extension v0.5.0 + all of Deploy B: waves 1–2.5) — Coolify deployment `ojy2hnhrpsp9noaxyvr2k2ow` (an earlier one, `efjlpfih2r7j5fmfofkbn0xr`, carried the pre-review code and was superseded). `NEXT_PUBLIC_USD_TO_UZS=12000` is now set on prod as a BUILD-TIME var (owner's number, 2026-07-20; it was unset and falling back to 12900).

**Local QA of authed pages is NOT possible from the dev machine** — the prod MySQL is not reachable from outside the VPS (`connect ETIMEDOUT` on every query, measured 2026-07-20). Live QA on data365.duckdns.org is the only option; don't waste a session rediscovering this.

**✅ LIVE QA DONE ON THE DEPLOYED BUILD (2026-07-20).** image `4cc00ca` · `/api/health` db+storage ok · security headers present (CSP frame-ancestors, HSTS, nosniff, SAMEORIGIN, referrer-policy) · anon surfaces `/login /signup /terms /privacy /s/<id>` all 200 (`/terms` was old 404 debt — now fixed) · unknown paths 307 → `/login` · share page renders player + tabs + comments, the Wave 2.5 **AI chat popup opens** (`.ai-popup open`, input "Uchrashuv haqida so'rang…") and the old `.ai-aura` glow is gone as intended · mobile 375px: no horizontal overflow, popup 351px, login CTA 294×44 · authed pages via a server-minted session (`docs/qa/SESSION_INJECTION_NOTES.md`): `/dashboard/caps`, `/extension`, `/settings/account`, `/meetings`, `/analytics`, `/settings/organization`, `/billing/ai-spend` all 200 · **`NEXT_PUBLIC_USD_TO_UZS=12000` verified BAKED INTO the deployed build** (present in `.next/server/**` and in the container env) · the site's zip downloads as **v0.5.0** and contains the in-page recorder.

**✅ DRIFT FIX IS NOW PROVEN ON PROD — but the ≤15s target is NOT met (2026-07-20, owner approved the re-transcription).** Same video, same rig, same 6-sample method, before vs after re-transcribing `fm3pz7yref328m7` (53 min) with the deployed fix:

| | before | after |
|---|---|---|
| max abs drift | **195.8s** | **25.0s** |
| mean abs | 51.2s | 10.5s |
| mean signed | −49.5s | −2.7s |

The systematic backward drift is GONE (−49.5s → −2.7s): that was the linear within-chunk clock error the fix targets, and the server logs show it firing per chunk (`cue-rescale x1.259 (speech span 359s)`). What remains is scattered, not systematic — one sample at −25.0s keeps max above the 15s target. **Do not claim "≤15s met".** Whether to chase the last 10s is the owner's call; the reading is now honest either way. Backup of the pre-run transcript: `/root/backup-fm3pz7yref328m7-20260720-1235.vtt` (restore path tested — see below).

**Two cost/robustness findings from the same run, worth acting on:**
1. **The free Gemini tier is never used — for TWO different reasons, so one fix will not cover both.** On the TRANSCRIBE side every chunk logged `Free probe aborted after 30000ms deadline` and fell back to paid (7/7); the paid call for the same chunk took ~360s, so a 30s probe may never finish by construction. On the AI-GENERATION side the same free key returns `HTTP 429: You exceeded your current quota` — the free key is exhausted or has no billing project behind it. So "bepul kvota bilan tejaldi" currently saves nothing on either path. **Fix them in this ORDER:** the 30s value is already flagged in the code as an untuned placeholder (`FREE_TRANSCRIBE_PROBE_MS`, "measured-p75 tuning is a blocked Phase-A follow-up"), but raising it BEFORE the key's quota is sorted would only make every chunk wait longer for the same fallback — i.e. slower AND still paid. Establish that the free key can answer at all first (owner-side: quota/billing), then tune the deadline against a measured p75.
2. **Gemini's dot-separated timestamps — FIXED in `9730cf5`, and they were also eating the drift fix.** A 12-sample re-measure still showed two bad samples (−18.7s, −66.7s) among ten good ones, which reads like an accuracy limit. It was a COVERAGE hole: the server logged 7 `cue-rescale` lines for 9 chunks, and both bad samples sat in a chunk that was never rescaled. Cause: Gemini writes cues as `00:00.000 --> 00:00.07.500` (= 0s, 7.5s, 14.5s read as a sequence), the pattern matched only the `00:00.07` prefix, every cue in that chunk collapsed to ~0.07s → the chunk looked "under-covered" → a PAID retry, twice → too few parsable cues → rescale skipped → those minutes kept full drift. `parseTimestampToSeconds` now reads that shape, and the pipeline **logs the SKIP** too (its silence is what turned a glance into an investigation). Regression tests proven to bite. **MEASURED after the `9730cf5` deploy (re-transcribed + 12-sample rig):** the parser fix delivered exactly what it claimed and nothing more — **paid retries 2 → 0**, chunk@2890 now rescaled (x1.071), 9/9 chunks accounted for in the logs. But **max drift did NOT improve: 65.9s** (mean_abs 14.4s, mean signed −11.8s). So the ≤15s target is still **NOT met**, and the reason is now precisely known rather than guessed.

**ROOT CAUSE OF THE ONE REMAINING OUTLIER (do not re-derive this).** The new SKIP logging named it on the first run: `chunk@361.27s cue-rescale SKIPPED reason=factor-out-of-range factor=1.007`. That chunk's surviving cues stop at **311s of a 362s span** — it is badly compressed and should have been stretched by ~1.16 — but at rescale time a lone cue reached ~359.5s, so `max(end)` said "already the right length" and the rescale declined to run. Drift inside that chunk grows −18.5s → −65.9s, the worst error in the recording. **The fix is not wrong; it never fires there.** The anchor is a single point (`max(end)`), and one stray trailing cue defeats it.

**✅ RESOLVED IN `13dfa48` — and the numbers moved.** Once every chunk got rescaled (the run of 13:45), the sample that had sat at **−65.9s came back at −3.5s** and max fell **65.9s → 28.6s** (mean_abs 10.2s, mean signed −4.3s over 12 samples; a second 9-sample pass at different offsets agreed: max 28.6s, mean 10.2s). The remaining −28.6s is the same defect in a milder form — the anchor inflated rather than skipped — and `13dfa48` fixes it by anchoring on the chunk's BODY: a final cue is treated as a stray when its gap exceeds **3× that chunk's own median cue spacing**. That ratio is not a guess; the probe gave nine real chunks with final gaps of 2.5/4.0/5.0/5.0/5.0/5.0/5.5/6.0s against ~6s spacing, versus **16.5s** on the one chunk that misled it. ⏳ **Its end-to-end number is UNMEASURED and cannot be taken today: the Gemini quota is EXHAUSTED.** The verification run after the `13dfa48` deploy failed with `All 9 transcription chunks failed … Gemini upload init failed (HTTP 429)` — four re-transcriptions of a 53-minute video in one afternoon spent the day's budget. **Nothing was lost:** the good transcript from the 13:45 run survived untouched (461 cues, 75171 bytes, last cue 00:52:47 — verified by reading the object back), the failed run only wrote an 8-byte `transcription-partial.vtt` which has been deleted, and `transcriptionStatus` was flipped back from ERROR to COMPLETE so the video reads correctly. **To finish this: re-run ONE transcription of `fm3pz7yref328m7` on a fresh quota day, then the 12-sample rig. Everything else is already in place.** Current honest standing: max 28.6s (target ≤15s), with the fix for that exact 28.6s case deployed but unproven end-to-end.

**⚠️ The FIRST attempt at this was written and REVERTED, deliberately — do not re-try that shape.** Ignoring a final cue that sits alone after a >20s gap fixed the prod case but turned **5 existing rescale tests RED** — their fixtures are legitimately sparse, so "isolated last cue" also describes normal speech. One production observation is not enough to justify a heuristic that reinterprets every chunk. The honest next step is a better anchor (e.g. fit the cue distribution rather than take its maximum), designed against several real chunks, not one. **The data collection for that is already shipped (`76e2545`): every chunk now logs `anchor-probe cues=… last=… 2nd=… p90=… span=… gapBeforeLast=…`, so the owner's NEXT real meeting produces the evidence at no extra cost.** Read those lines with `docker logs <app> | grep anchor-probe`, look at the chunks whose `last` sits far above `p90`, and design the rule against all of them at once.

**(historic, for the record) The earlier dead end and why the first attempt could not measure it.** The rig reproduced the BASELINE on prod (`j1q9mjg8kewr2en`, 6 samples: max **94.4s**, mean −38.4s — same shape as the 113.5s ten-sample baseline), which only re-measures the OLD transcript; proving the fix needs a video transcribed by the NEW code. I picked the one video that could be transcribed with nothing to lose (`t91bnh582gnhgy8`, the 07-19 meeting, `transcriptionStatus` was NULL) and transcribed it — it worked, and it now has a transcript + AI summary. But it CANNOT measure drift: the rig's ground truth needs 20s clips loud enough to transcribe on their own, and this recording is quiet (whole file mean **−37.7 dB**, the middle 82–300s between **−53 and −66 dB**; the transcript legitimately covers only 0–82s and 300–416s). Amplifying it +25 dB did not help. **To prove the ≤15s target, one of the long LOUD videos must be re-transcribed (`fm3pz7yref328m7` 53 min, or `bbzt2424z6vvy6t` 117 min) — that OVERWRITES an existing transcript, so it is the owner's call, not mine.** Backups sit at `/root/backup-<videoId>-*.vtt` on the server, and the way HOME is now real, not hoped: `scripts/drift-restore.mjs` writes a VTT back and reads it straight back to confirm (proven on a scratch key — `wrote=79178 readBack=79178` — then the scratch object was deleted).

**A suspicion I raised and then RETRACTED, recorded so it is not re-raised:** the quiet recording plus a fluent transcript looked like an AI hallucination, and I nearly reported it as one. Two measurements killed it: the transcript's coverage gap matches exactly where the audio is silent, and the clip at 395s has real speech-band signal (mean −40.5 dB, peak −9.6 dB). The transcript is consistent with the audio. What IS real: **his meeting audio is quiet**, which is worth watching now that `TAB_AUDIO_GAIN=1.8` ships.

**Still owner-only:** the 2-person Meet run of `docs/OWNER_QA_SCRIPT.md` (rewritten for the 2-step flow).

**⛔ OWNER TODO (~10 min, the only thing no machine can do):** data365.duckdns.org/dashboard/extension → download the zip → `chrome://extensions` → **remove the old data365 Recorder** → Load unpacked the new folder → it must read **0.5.0**. Then open a Meet with one other person, press **Record now** in the card at the top of the page, pick **Entire Screen**, talk for 2 minutes, Stop → the recording must appear under **Meetings** and their voice must be audible. If the card does not appear, `Ctrl+Shift+9` still works — say which one you used.

---
## 🟢 2026-07-21 — CREDIT-FREE BACKLOG SWEEP (owner: "gemini kredit talab qilmaydigan barcha ishlar")

Read the full 416 KB archive + cross-checked each candidate against current code (git is AHEAD of the old notes — several audit items were already fixed: H13 erasure cascade DONE in `delete-account.ts`, desktop delete twin now routes `permanentlyDelete`, idempotency test tracked, `shared-caps` dead route gone, C2 signup no-org membership DONE at `signup.ts:124`).

**LANDED this session (branch `qa-fixes`, NOT deployed — owner approval needed to deploy):**
- `2463c0b` **H5** — extension `result.mp4` uploads declared `size:0`, so real bytes never reached quota accounting. `/complete` now persists the S3-verified `storedBytes` into `videoUploads` in the same txn as the raw-recorder branch. Failing-test-first, 30/30 multipart tests pass.
- `2678cad` **SDK `/complete` guard** — developer SDK multipart complete had no part-list validation (web + extension paths both do). Added the same `isSequentialPartList` 1..N guard BEFORE the credit debit, non-empty etag, split schema. 16 new tests.
- `51f5d2e` **HELD: free-probe quota-skip** — built but NOT shipped: mutates a shared object inside a `"use step"` (durable), unprovable across the step boundary + unverifiable during the outage. Patch + step-safe redesign in `docs/plans/2026-07-21-free-probe-skip-HELD.md`. Finish when credit returns.
- `d15aebf` **Extension discard terminal-state fix** — when a discard raced a terminal state (`complete` share link / `error` "re-record") for the SAME already-deleted video, the popup showed a dead link / a re-record lie. Now shows a non-recoverable "discarded" state; recording-B (different videoId) left untouched. 2 fail→pass tests, recording-B adversarial test still green.
- `ebf514b` + `f5534e5` **Extension full Uzbek pass** — recorder/meet/options + popup/sw/upload strings translated (consistent glossary), coupled test assertions updated. Blast-radius honored: START_INSTRUCTION source strings kept English because `friendlyStartError()` `.includes()`-matches them. Extension suite **134/134 green**, LF, no new typecheck errors.
- `6936b83` **Extension v0.5.0 → 0.5.1 + repackaged zip** (both `apps/365-extension.zip` and `apps/web/public/365-extension.zip`).

**⚠️ DEPLOY DECISION PENDING (owner):** all of the above is committed to `qa-fixes` (HEAD `6936b83`) but **NOT deployed** — prod still serves `4cc00ca` / extension **v0.5.0**. So downloading the zip from prod today still gives 0.5.0; the new extension work (discard-fix + Uzbek + v0.5.1) is only visible AFTER a deploy. The web security fixes (H5, SDK) likewise ship only on deploy. Deploy is owner-gated (STATE rule + outage caution). When approved: deploy web + extension together, then the owner install/QA todo below expects **v0.5.1**.

**Deliberately NOT done, with reasons (do not re-chase without deciding):**
- **HSTS max-age bump** — `next.config.mjs:132` has an explicit reasoned decision to keep it short (cert-lapse lock risk on self-hosted duckdns). Left as-is. Owner call: only ramp once cert-renewal has proven itself over several cycles.
- **Settings `<title>` i18n** — the WHOLE dashboard hardcodes English titles; changing one page = a new one-off pattern. Needs an app-wide i18n-titles pass if wanted, not a patch.
- **server-env Zod leak** — grepped the compiled client bundle: NO secret/`serverEnv` leak reaches the client today. Only a structural "safe-by-convention" risk; real fix (add `import "server-only"` + split `@cap/env` exports) has blast-radius on ~15 client importers of the barrel — a deliberate task, not a quick edit.
- **XFF/IP spoof, nonce-CSP, Biome 676-file lint** — all need either live Coolify-proxy testing (lockout risk) or huge CRLF churn; low value / high risk. Skip.

**STILL OPEN & credit-free (owner to steer):**
- **Recorder a11y gaps** (focus mgmt, live regions, semantic modal, reduced-motion) — real, credit-free, medium; LOW priority for an internal-team desktop tool. Recommend defer.
- **Chunk-streaming refactor** (hoist duplicated `sendMsg`/`ondataavailable→RECORDER_CHUNK` across the 3 recorder files) — verifiable via extension tsc + 134 vitest + e2e-audio-proof (no Gemini). But it's a NO-benefit refactor that risks the #1 feature (recording); the debt was explicitly deferred "until one of them changes." Recommend NOT now.
- **Requester "we'll contact you" screen + owner pending-requests dashboard** (three-kinds-of-person model) — needs owner product/design direction.
- **Auto video-name templates → i18n** — owner decision; couples to `generate-ai.ts` `GENERATED_TITLE_PATTERN` (translate the generator AND the regex together or AI stops retitling).

**DONE this session (were in the above list):** extension terminal-state stale message (`d15aebf`); extension i18n / Uzbek consistency across recorder+meet+options+popup+sw+upload (`ebf514b`,`f5534e5`).

---
---
# ===== BINDING DECISIONS (do NOT re-litigate) =====

## ⭐ OWNER DECISIONS — infra & data (2026-07-18, SESSION i) — BINDING

1. **Domain: STAY on the free `*.duckdns.org` for now.** Owner explicitly declined buying a domain at this stage. Consequence to remember: no mail provider can be verified on it (so transactional email stays unavailable — fine, the access model needs none), and it must be revisited before any wider/commercial launch. Do NOT re-raise this before then.
2. **Account deletion = REAL deletion, with a hard confirmation gate.** Owner rejected soft-delete/grace-period. Data is actually erased; the safety net is friction, not retention: require the user to TYPE an exact confirmation phrase (e.g. "delete my all data") before anything is destroyed — so nobody wipes their account by misclicking. This answers audit finding H13: the erasure workflow must inventory and purge recordings, storage objects, transcripts, AI data, comments, analytics and API keys — not just the user row (`apps/web/actions/account/delete-account.ts:32-39` currently deletes only membership/session/OAuth/user).
3. **Firewall: owner asked for an independent check first** (Codex or Fable) rather than acting on Claude's word alone — correct instinct, since a wrong rule locks everyone out of the VPS.

## 🔁 STANDING REQUIREMENT — SERVER PORTABILITY (owner, 2026-07-18)

The Railway → Contabo/Coolify migration was painful. Owner's directive: **build so that changing servers is never that painful again.** Treat host-portability as a real requirement, not a nice-to-have — no hidden coupling to one provider, everything needed to stand the app up elsewhere must be written down and reproducible. Judge future infra choices against "how hard is it to move off this?"

## 🚦 AGREED ROAD TO PRODUCTION (owner, 2026-07-18) — follow this order, do not skip a step

1. **Claude finishes the code fixes** (audit findings C1–C4, H1–H16, M1–M12 as scoped).
2. **Fable AND Codex each re-audit production-readiness independently** — separately, neither seeing the other's report, same as the SESSION-h heart audit that both returned "STILL BROKEN" and was trusted precisely because they converged.
3. **Only after both sign off** → Claude writes a step-by-step OWNER QA SCRIPT: one instruction at a time, each saying where to click, what should happen, and what "wrong" looks like. Owner is a non-programmer — no jargon, no batched steps.
4. **Owner executes the human-only half**: real Google Meet capture on a laptop, real device playback, phone checks. Claude does everything a machine can do; the owner does only what genuinely needs hands and a real device.
5. Deploy only after that.

Owner's framing: *"qila oladiganingni sen qilasan"* — do not hand the owner a task a tool could have done. Manufactured busywork trains him to ignore the list.

## ⭐ OWNER PRODUCT DECISIONS (2026-07-18, SESSION i) — BINDING, do NOT re-litigate

Pinned during the Codex production-readiness review. These define the access/billing model:

1. **THREE KINDS OF PERSON (owner confirmed "ha shunday", 2026-07-18).** This is the access model — build everything against it:
   - **Guest** — no account. Arrives via a share link. Can WATCH + use AI CHAT (daily-capped). Nothing else.
   - **Requester** — signed up on their own. Has an account but **NO organization membership at all**. Sees a friendly "we'll contact you to open your workspace" screen, NOT a dead end — a curious customer signing up is a **sales lead**, so the owner gets a list of pending requests in the dashboard (who, when, which email) with approve/dismiss.
   - **Member** — the owner explicitly added them to the company org. Full product.
   **Free users never record.** They only watch + chat. So a self-signup needs NO workspace of its own — the earlier "give each signup their own org" plan is CANCELLED (owner: storage is only 10 GB free; signup exists mainly so the owner can add members).
   **Signup stays OPEN and needs NO email verification** — safe precisely because a stranger who signs up sees nothing and stores nothing. The C2 defect is that `apps/web/actions/auth/signup.ts:135` calls `getDefaultOrganizationId()` and inserts `organizationMembers role:"member"` → today every internet stranger becomes a member of the owner's team org. Fix = create the user with NO org membership.
   Telegram notification on a new request: raised, **not confirmed by the owner** — do not build it until asked.
2. **AI spend is privileged.** Only **admin/owner** can trigger paid AI *analysis* (transcript, summary, generation). A free user cannot spend AI money.
3. **AI chat is available to free users AND to anonymous visitors arriving via a share link** — but **rate-limited (owner chose option B)**: a per-video / per-client daily cap so guest chat cannot drain the Gemini budget. Not unlimited (C rejected), not admin-only (A rejected). Rationale: guests seeing the product is a growth channel, the cap keeps the bill bounded.
   **ALREADY BUILT** — `apps/web/lib/ai-chat-limit.ts` `DAILY_CHAT_LIMIT = 20`, DB-backed (`ai_chat_usage` table, unique on videoId+clientId+dateUtc, migration `0036`), so it survives restarts. Keyed by userId when signed in, else a cookie, else `guest_ip:<ip>`. Kept at **20** (status quo, live-verified); owner never asked to lower it to 10 — do not change the number without asking.
   ⚠️ **KNOWN BYPASS, not yet fixed:** the IP is read as `x-forwarded-for.split(",")[0]` — the LEFTMOST hop, which a caller can spoof. Repo-wide convention (`password.ts`, `helpers.ts`, `api/utils.ts` do the same). Fixing it means taking the proxy-appended hop instead, but **Coolify's proxy behaviour is unverified and is NOT in this repo** — must be tested live against data365.duckdns.org before changing. Do not guess.

5. **AI spend gate — a hole was found and closed this session.** `apps/web/app/api/videos/[videoId]/retry-ai/route.ts` had NO `canUseAI` check: any signed-in video owner could POST to it and trigger paid Gemini generation. It has zero callers in the web UI (orphaned duplicate of `generate` with `reprocess:true`) but was a live reachable route. Now gated with the same `canUseAI` + `AI_ACCESS_DENIED_CODE` as generate/continue-paid/translate. Note `canUseAI` = global `users.isAdmin` ONLY; org-level "owner" role grants no AI spend (verified: all 14 `role === "owner"` sites are org-scoped and cannot escalate to platform admin).
4. Domain purchase is still open; email sending is NOT configured (`.env` has no mail provider) and decision 1 means it is not on the critical path.

## ⚠️ Don't re-chase (proven false alarms / parked)
- **Video "stuck" in MY heavy-probing browser = self-poisoning** (connection-pool exhaustion), NOT a delivery bug. Test ONE clean tab. `fetch` of result.mp4 → 206; it plays for real users. [[feedback_clean_env_before_live_bug]]
- **Embed #310** was a stale build — resolved.
- **CDN Worker** (`ustoz-media-cdn.data365.workers.dev`) is LIVE but DEACTIVATED; app falls back to R2 presigned (working, 5/5 206). Re-activation needs the in-browser-only hang diagnosed first — recipe in the archive + `docs/DEPLOY_SECRETS.md`.


---
# ===== LIVE ENVIRONMENT (verified 2026-07-20 — trust RUNBOOK.md over this) =====

⚠️ **This block was WRONG until 2026-07-20** — it still named Railway URLs and a Railway MySQL long after the Contabo/Coolify migration. A new session reading it would have probed a dead host. Corrected against `docs/RUNBOOK.md` (itself re-verified 2026-07-17/18). **If these disagree, RUNBOOK wins.**

- **Live site:** https://data365.duckdns.org — liveness = `/api/health` returns `"status":"ok"` with `db:"ok"`, `storage:"ok"`.
- **Server:** Contabo VPS managed by **Coolify** (UI at `http://<CONTABO_IP>:8000`). NOT Railway — Railway is gone.
- **DB:** MySQL inside Coolify. **Not reachable from the dev machine** (`connect ETIMEDOUT` from outside, measured 2026-07-20) — so local QA of authed pages is impossible; QA on the live site instead.
- **Storage:** Cloudflare R2. **Backups:** R2 `db-backups/`, the authoritative series is `capdb-*.sql.gz` written by the VPS cron `/root/backup-db.sh` (source in `deploy/server/`). The GitHub `db-backup.yml` series (`data365-*.sql.gz`) points at the deleted Railway DB — ignore it.
- **Repo:** GitHub `mirkomilovabrorwork-dot/ustoz-github`. Work branch **`qa-fixes`**; scheduled jobs only run from **`main`** (GitHub only schedules from the default branch).
- **Deployed:** commit `4cc00ca` (extension v0.5.0), Coolify deployment `ojy2hnhrpsp9noaxyvr2k2ow`. `NEXT_PUBLIC_USD_TO_UZS=12000` is a BUILD-TIME var and is baked into the deployed image.
- **`ELEVENLABS_API_KEY` is NOT set on prod** (verified by `printenv`) — the "Timestampni aniqlashtirish" button therefore cannot work.
- **GATE = ROOT `pnpm typecheck` + BOM-check changed files** (the `-F @cap/web` typecheck is a no-op false-green).
- **Node not on PATH:** `$env:Path = "C:\Program Files\nodejs;" + $env:Path`. Windows has no `zip` CLI → `Compress-Archive`.
- **Deploy rule:** do NOT push / deploy / force-checkout without explicit owner approval.
- **NEVER commit** (temp, untracked): `apps/web/scripts/_qa-import.ts`, `import-real-video.ts`.

## 🙋 OWNER-PHYSICAL (only he can do)
1. **Extension v0.5.0 install + 2-person Meet run** — the full script is in the "NEXT SESSION" block above and in `docs/OWNER_QA_SCRIPT.md`. This is the open one.
2. **Top up Gemini billing** at https://ai.studio/projects — every AI feature on prod is down until this happens (he said credit is being bought 2026-07-21).
3. **Add GitHub repo secret `CRON_SECRET`** (value in `docs/DEPLOY_SECRETS.md`) → Settings → Secrets → Actions. Until then the recover cron skips safely.
4. Chrome Web Store publish (later; $5 dev account).
5. Optional, only if he picks the paid timing path: supply an **ElevenLabs API key** → set in Coolify → redeploy.

---
# ===== HISTORY =====

Everything before 2026-07-20 — 30+ session handoffs, the Codex QA runs, the Fable heart audits, the per-commit fix logs — lives in **`docs/STATE_ARCHIVE_2026-07-20.md`** (the full 416 KB file, verbatim, nothing deleted). Older still: `STATE_ARCHIVE.md`, `STATE_ARCHIVE_2026-06-23.md`.

Why it was moved (2026-07-20): STATE.md had grown to **416 KB / 1895 lines** — too large for a session to read, so the resume guarantee it exists to serve was already broken in practice, and a stale env block at the bottom was actively feeding new sessions false facts. Rule for keeping it that way: **STATE.md holds the live point + binding decisions only.** When a session's handoff is superseded, move it to the archive in the same commit — do not stack it here.
