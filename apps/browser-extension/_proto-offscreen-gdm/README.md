# Spike: offscreen `getDisplayMedia` (T11/T12 gate)

Throwaway. Proves the single make-or-break unknown from
`docs/plans/2026-07-11-recorder-design.md`: can an **offscreen document**
(created with reason `DISPLAY_MEDIA`) run `getDisplayMedia`, show a picker,
and coexist with a `tabCapture` audio track — mixing screen video + remote
audio + mic into one recording, with no echo?

If YES → build Design B. If NO → build fallback Design A′.

## How to run (owner, ~5 min, real Chrome)

1. Open a **Google Meet with a 2nd participant** (or any tab playing audio,
   e.g. a YouTube video) in a normal tab — this gives real remote audio.
2. `chrome://extensions` → enable **Developer mode** (top-right) →
   **Load unpacked** → select this folder
   (`apps/browser-extension/_proto-offscreen-gdm`).
3. Click the extension's toolbar icon → a **tester tab** opens.
4. Click **▶ Run capture test** → when the screen-picker appears, pick a
   window/screen that is **NOT the tester tab** (ideally a presented window).
5. Talk into your mic ~6s. It records, then plays back in the tester tab.

## What to report back to me

- The **VERDICT** line (green = works / red = failed) + the step-4 detail text.
- If it recorded: in the playback — do you **see** the picked screen, **hear**
  the remote participant, **hear** your mic, and is there **NO echo**?
- Was the picker UX acceptable (right monitor choice, cancelable)?

That's the whole gate. Delete this folder afterward.
