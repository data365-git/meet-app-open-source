# 2nd-recording "Mijoz ovozi olinmadi" bug — root-cause investigation + fix plan

**Date:** 2026-07-22 · **Investigator:** Fable (independent, non-author) · **Deployed:** extension v0.5.2
**Symptom (owner, real Meet call):** 1st in-page recording works; 2nd recording on the same Meet page shows
"Mijoz ovozi olinmadi. Baribir boshlaymizmi? (faqat ekran va mikrofon yoziladi)".

---

## 1. Confirmed root cause

**Recording #1's cleanup permanently kills the capture tracks of Meet's media elements by calling
`MediaStreamTrack.stop()` on `captureStream()`-derived tracks. On recording #2, `captureStream()` hands back
wrappers around those same now-dead underlying tracks → zero live taps → the confirm dialog.**

Status: **confirmed at mechanism level** from the extension code + Chromium (Blink) source, and it is the only
cross-recording persistent state that exists (every other candidate was checked and eliminated, §1.3). Final
end-to-end confirmation = the two-recording harness run in §6 going RED on unfixed code.

### 1.1 The chain, with evidence

1. **The kill.** `detachAllPageAudio()` stops the captured tracks on every recording stop:
   - `apps/browser-extension/src/content/inpage-recorder.ts:229-237` — `for (const t of tap.stream.getTracks()) t.stop();`
   - It runs from `cleanup()` (`:253-261`), which runs from `finishStop()` (`:537-541`) — i.e. on EVERY normal stop.
   - `tap.stream` is the raw return of `el.captureStream()` (`captureFrom`, `:139-152`, stored at `:197`).

2. **Why stopping those tracks is destructive beyond our own state.** Real Meet `<audio>`/`<video>` elements are
   **srcObject-backed** (WebRTC `MediaStream`s). Blink's `captureStream()` has a special path for exactly that case
   (`third_party/blink/renderer/modules/mediacapturefromelement/html_media_element_capture.cc`):

   ```cpp
   // If |element| is actually playing a MediaStream, just clone it.
   if (element.GetLoadType() == WebMediaPlayer::kLoadTypeMediaStream) {
     ...
     return MediaStream::Create(context, element_descriptor);   // the ELEMENT'S OWN descriptor
   }
   ```

   `MediaStream::Create(context, descriptor)` builds **new JS `MediaStreamTrack` wrappers around the element's own
   underlying `MediaStreamComponent`s — no cloning of components** (`media_stream.cc`, MediaStream constructor:
   `MakeGarbageCollected<MediaStreamTrackImpl>(context, descriptor_->AudioComponent(i))`). So "our" tap tracks and
   Meet's own remote-audio tracks share one underlying platform track. There is no isolation.

3. **What `stop()` does to that shared track.** `MediaStreamTrackImpl::stopTrack`
   (`media_stream_track_impl.cc:435-458`):
   - synchronously `Component()->GetPlatformTrack()->SetEnabled(false)` — "prevent media from flowing" (crbug.com/1320312);
   - `UserMediaClient::StopTrack(Component())`, which resolves to
     `MediaStreamTrackPlatform::GetTrack(component)->StopAndNotify(...)` (`user_media_client.cc:210-216`) —
     a **terminal** stop of the shared platform track. Platform tracks never restart.

4. **Why recording #2 sees zero taps.** A fresh `captureStream()` call does return a NEW `MediaStream` object each
   time (so the exact wording of the original hypothesis — "same MediaStream instance" — is wrong), but on the
   srcObject path the new stream wraps the SAME dead components. New wrappers are born with the component's ready
   state (`media_stream_track_impl.cc:253-258`: `ready_state_(component->GetReadyState())`) — **ended**. Then:
   - `inpage-recorder.ts:167-170` — `stream.getAudioTracks().find((t) => t.readyState === "live")` → `undefined` → element skipped;
   - every previously-tapped element is skipped → `tapped === 0` (`:471`, gate at `:479`);
   - → `host.confirmWithoutClientAudio()` → the exact dialog the owner saw
     (string at `apps/browser-extension/src/content/meet-detect.ts:622`).

5. **Why it looks intermittent.** The poison clears only when Meet swaps a NEW srcObject stream into the element
   (new components). Speaker changes do that. So a 2nd recording started right after a speaker change would work;
   one started during a stable stretch of the call fails. Timing-dependent — classic "worked yesterday".

### 1.2 Spec note (for the record)

The W3C mediacapture-fromelement spec does not pin down repeated-call behavior; the governing fact is the Blink
implementation quoted above. The spec does say a captured track "ends when playback ends… Since a MediaStreamTrack
can only end once, a track that is enabled, disabled and re-enabled will be captured as two separate tracks" —
consistent with: once ended, that track object never comes back. Sources:
- https://w3c.github.io/mediacapture-fromelement/
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediacapturefromelement/html_media_element_capture.cc
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/media_stream_track_impl.cc
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/user_media_client.cc

### 1.3 Alternative causes checked and ELIMINATED

| Candidate | Verdict | Evidence |
|---|---|---|
| Stale `taps` Map | No — `InPageState` is rebuilt per recording; fresh `Map` (`inpage-recorder.ts:465`) |
| Closed AudioContext reused | No — new `AudioContext` per start (`:446`) |
| MutationObserver leak | No — `rescan.disconnect()` in cleanup (`:256`), new observer per start (`:601-606`) |
| Module flags (`intentionalStop`, `clientAudioWaived`) | No — reset at start (`:362-363`) |
| SW arming state stale | No — `MEET_NUDGE_CAPTURE_READY` re-arms per recording (`sw.ts:1081-1111`); field-confirmed: recording #2 reached the dialog, which is AFTER a successful arm |
| `state` not cleared | No — `finishStop` nulls it (`:538-539`) |

The `t.stop()` damage is the **only** state that survives from recording #1 into recording #2.

### 1.4 Collateral worth watching (not claimed as confirmed)

Because the stopped components are Meet's own, stopping them may also interrupt the element's own playback until
Meet self-heals by attaching a fresh stream. The owner did not report in-call audio loss, and Blink's WebRTC audio
rendering partially bypasses the sink path that `SetEnabled(false)` gates — so this is flagged as a watch-item for
the live test, not asserted. Either way it is one more reason we must never `stop()` tracks we do not own.

---

## 2. Is voice actually being lost, or is the warning a false alarm?

**Partly a false alarm — the warning copy is FALSE in the owner's exact scenario.**

When the owner picked **Entire Screen + "Share system audio"** and clicked "Baribir boshla":
- `inpage-recorder.ts:500-505` wires `displayStream`'s system-audio track through `systemGain` into the recorded mix.
- System (loopback) audio on Windows contains everything the machine plays — **including the client's voice from Meet**.
- So the degraded 2nd recording **does contain the remote voice**, plus mic, plus screen.

The two strings claiming otherwise are therefore **misleading** whenever system audio was shared:
- `meet-detect.ts:622` — "…(faqat ekran va mikrofon yoziladi)" — false; system audio is recorded too.
- `inpage-recorder.ts:648` — "⚠️ Mijoz ovozisiz yozilmoqda — faqat ekran va mikrofon." — same falsehood.

**When the voice IS genuinely lost:** (a) the user did NOT tick "Share system audio" (then the copy is true);
(b) system loopback follows the speaker output — if the owner mutes his speakers / drops volume to near-zero /
switches output device mid-call, the loopback goes quiet while the DOM tap would have been immune. This is why the
tap must stay the PRIMARY path and system audio the fallback — not the other way round (see Option B assessment).

Watchdog interplay in the degraded path (checked): the analyser hears only taps, but the 2-minute silence warning is
suppressed by `clientAudioWaived` (`:638`), and if a tap attaches mid-recording the stand-in is muted (`:206-209`)
so no echo. No additional defect there.

---

## 3. Why this shipped: the coverage gap

- **Unit tests** (`inpage-recorder.test.ts`): no second-recording scenario at all. `detachAllPageAudio`/`cleanup`
  are not exported and never exercised. Worse, `FakeTrack.stop()` is a **no-op** (`stop: () => {}`, line 28), so
  even an attach→detach→attach test written against the current fakes would have passed. The fake models Chrome's
  "same stream object" behavior for source swaps but not the destructive semantics of `stop()`.
- **E2E harness** (`e2e-audio-proof`): (a) records ONCE per run — never two back-to-back recordings; (b) the fake
  Meet's tone element is **file-backed** (`el.src = "/tone.webm"`, `fake-meet/index.html:47-65`), and in Blink a
  file-backed element takes the OTHER `captureStream()` path (a fresh per-call capturer via
  `CreateHTMLAudioElementCapturer`) — which **cannot reproduce this bug class** even with two recordings. The
  harness's element model diverged from real Meet on exactly the axis that mattered.

---

## 4. Fix options, ranked

### Option A — surgical: never `stop()` captureStream-derived tracks (RECOMMENDED, ~1 line)

**Change:** in `detachAllPageAudio` (`inpage-recorder.ts:229-237`), delete the line
`for (const t of tap.stream.getTracks()) t.stop();` — keep `tap.source.disconnect()` and `s.taps.clear()`.

**Why it is correct, not just convenient:** on the srcObject path those tracks are wrappers around **Meet's own
live tracks** — the extension never owned them and has no business ending them. Our real resources are fully
released elsewhere: the WebAudio source nodes are disconnected, and `cleanup()` closes the whole `AudioContext`
(`:260`). The wrapper `MediaStream`s simply become garbage. No capture indicator, no privacy surface: nothing about
a remote WebRTC track lights an indicator, and captureStream on the srcObject path creates no capturer to leak.

**Cost/risk:** minimal. The only theoretical cost: on a NON-srcObject element (file/MSE-backed — real Meet has
none that matter) a captureStream capturer would stay alive until the element/document goes away. Accepted.

**Blast radius (checked):**
- `cleanup()` still stops `displayStream` and `micStream` (`:258-259`) — REQUIRED and untouched (releases Chrome's
  share bar + the mic-in-use light; those streams are per-recording and ours).
- `pruneDeadTaps` never stopped tracks — untouched.
- **Twin check (the copy-paste rule):** `captureStream` exists ONLY in `inpage-recorder.ts` (grep-verified across
  `src/`). `offscreen/recorder.ts:137-141` and `recorder/recorder-page.ts:356-367` stop only their own per-recording
  `getDisplayMedia`/`getUserMedia`/tabCapture-derived streams — freshly minted each recording, stopping them is
  correct and required (tabCapture would otherwise keep the tab muted). **No twin defect.**
- Unit-test fakes must gain real `stop()` semantics (see §6.1) or the regression test proves nothing.

### Option B-lite — honest gate + copy when system audio exists (RECOMMENDED as companion, small)

Today the `tapped === 0` gate (`:479`) treats "no page tap" as "no client voice", which §2 shows is wrong when
system audio was shared. Change the gate to account for `displayStream.getAudioTracks().length > 0`:

- **No tap, system audio PRESENT** → do not show the scary confirm at all (or show a soft, true note):
  proceed, wire the stand-in (already implemented at `:500-505`), and note
  "Mijoz ovozi tizim ovozi orqali yozilmoqda" instead of `:648`'s "Mijoz ovozisiz…". Keep setting
  `clientAudioWaived = true` so the silence watchdog stays suppressed exactly as today.
- **No tap, NO system audio** → keep the confirm; its current text is then actually true.
- Interface change: `host.confirmWithoutClientAudio()` and the card copy at `meet-detect.ts:622` need a
  `hasSystemAudio` input (or two distinct messages) so the dialog never lies.

**Value:** even if some future Meet change breaks the taps again, the owner never sees a false
"client voice lost" alarm while the voice is in fact being recorded. This directly de-fangs the #1-feature failure mode.

**Why NOT full "system-audio-as-PRIMARY":** loopback is hostage to the speaker path (mute/volume/device switch,
§2), captures non-Meet system sounds, and demoting the tap would trade a now-fixed deterministic bug for a
permanent environmental fragility. The current architecture (tap primary, system audio auto-fallback with
anti-echo muting) is right; it only needs A + honest copy.

### Option C — desktop app: NOT warranted

- What it buys: OS-level loopback (WASAPI) independent of Meet's DOM, no extension review cycle, richer control.
  But the extension ALREADY reaches OS loopback via getDisplayMedia system audio — the marginal robustness is small.
- What it costs: weeks (capture engine, uploader re-integration, auto-update, code-signing, distribution to the IT
  team's machines), and it does not auto-solve meeting UX (still needs a picker/consent per OS rules).
- The actual defect is a **one-line self-inflicted `stop()`**, provable in CI after the §6 harness change. Building
  a desktop app to route around a one-line bug would be the wrong lesson. **Recommend against**, unless A+B-lite
  fail the live 2-recording test on a real call — which the evidence says they will not.

---

## 5. Recommendation

**Ship A + B-lite together** (one small PR: delete the stop-loop; make the gate/copy system-audio-aware), with the
proof in §6. Order of proof: unit test RED→GREEN first, then the PROOF_SECOND harness run RED on current v0.5.2
code → GREEN on the fix, then the owner's real 2-recording Meet check as final confirm.

---

## 6. Exact proof method

### 6.1 Unit test (runs in CI on every commit)

In `inpage-recorder.test.ts`:
1. Give the fake real semantics: `FakeTrack.stop()` sets `this.readyState = "ended"` (models
   `MediaStreamTrackImpl::stopTrack`; the fake's captureStream already correctly returns the same stream/track
   objects across calls, which models the srcObject component-sharing).
2. Export `detachAllPageAudio` from `inpage-recorder.ts` (pure function of state; trivial export).
3. New test — "a second recording can still tap the same elements after the first one is cleaned up":
   ```ts
   const el = new FakeElement(track("t1"));
   elements = [el];
   const s1 = makeState();
   expect(attachPageAudio(s1)).toBe(1);
   detachAllPageAudio(s1);            // recording #1 stops
   const s2 = makeState();            // recording #2 = fresh state, same page
   expect(attachPageAudio(s2)).toBe(1); // RED today (stop() ended t1) → GREEN with fix
   ```

### 6.2 E2E harness (`e2e-audio-proof`) — reproduces the owner's bug, then proves the fix

Three concrete changes:

1. **`fake-meet/index.html`: add `?tone=stream` mode** — the tone element must be **srcObject-backed** like real
   Meet, because the existing file-backed mode takes the other Blink path and cannot reproduce the bug:
   ```js
   const ctx = new AudioContext();
   const osc = ctx.createOscillator(); osc.frequency.value = 440;
   const gain = ctx.createGain(); gain.gain.value = 0.05;
   const dest = ctx.createMediaStreamDestination();
   osc.connect(gain).connect(dest); osc.start();
   const el = document.createElement("audio");
   el.srcObject = dest.stream; el.autoplay = true;
   document.body.appendChild(el);
   ```

2. **`mock-server.mjs`: per-recording sessions.** Today one global `parts` Map + one `manifest.json`; a second
   upload would collide with the first (stale high-numbered parts from recording #1 would corrupt recording #2's
   assembly). On each `/api/desktop/video/create`: increment a session counter, `parts.clear()`, write
   `manifest-<n>.json` and assemble to `recording-<n>.bin`.

3. **`run-proof-inpage.mjs`: add `PROOF_SECOND=1`** (sibling of `PROOF_SWAP`), page URL `?tone=stream`:
   - click the record button → pill → record ~8s → click stop → wait for `manifest-1.json` complete;
   - re-find and click the record button again (card re-renders after stop);
   - **THE ASSERT THAT IS THE OWNER'S BUG:** if the confirm box appears (probe the closed shadow root for the
     "Baribir boshla" button via the existing `centreOfShadowNode`) → `VERDICT=FAIL reason=second-recording-lost-page-audio`;
   - otherwise pill → ~8s → stop → wait `manifest-2.json` → run `analyze-audio.mjs` on `recording-2.bin`:
     tone energy above the existing −50 dB threshold → `VERDICT=PASS`.
   - ⚠️ Harness maintenance required regardless: the button-text probes still say "Record now"/"Stop", but the UI
     was translated in v0.5.1 — update to **"Hozir yozish"** / **"To'xtatish"** or every variant BLOCKS on
     button-not-found.
   - Run (headed Windows, as before): `PROOF_SECOND=1 node run-proof-inpage.mjs`.
     **Expected: FAIL on current code (bug reproduced) → PASS after Option A.** That FAIL-first run is part of the
     proof — do not skip it.

### 6.3 Final owner confirm (unchanged from the standing QA script)

One real Meet call, record → stop → record again on the same page: the second recording must start with NO
"Mijoz ovozi olinmadi" dialog and the client's voice must be audible in BOTH files under Meetings.

---

## 7. Copy fixes (independent of which option ships)

| Location | Today | Fix |
|---|---|---|
| `meet-detect.ts:622` | "Mijoz ovozi olinmadi. Baribir boshlaymizmi? (faqat ekran va mikrofon yoziladi)" | Only when NO system audio. With system audio shared: skip the dialog (B-lite) or state "Mijoz ovozi tizim ovozi orqali yoziladi". |
| `inpage-recorder.ts:648` | "⚠️ Mijoz ovozisiz yozilmoqda — faqat ekran va mikrofon." | When `systemGain` is wired: "⚠️ Mijoz ovozi tizim ovozi orqali yozilmoqda." |
| `inpage-recorder.ts:89-90` (`NO_CLIENT_AUDIO_MSG`) | fine (abort path) | unchanged |

---

## Appendix: what the original hypothesis got right and wrong

- **Right:** the dialog is the `tapped === 0` branch; the killer is `detachAllPageAudio`'s `t.stop()` on
  captureStream-derived tracks; recording #2 receives already-dead tracks; the `readyState === "live"` filter skips
  them.
- **Refined:** `captureStream()` does NOT return "the SAME MediaStream instance" on repeated calls — Blink returns a
  new `MediaStream` object every call. The persistence is one level deeper: for srcObject-backed elements every
  returned stream wraps the element's own underlying components, and `stop()` kills those shared components
  terminally. Same practical effect, different mechanism — and the difference matters for the harness design
  (§6.2.1: a file-backed fake element would NOT reproduce the bug).
