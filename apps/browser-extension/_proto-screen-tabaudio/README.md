# PROTO — screen video + tab audio (Design B spike)

Throwaway. Proves ONE thing before we rebuild the real recorder:

> Can we record **entire-screen video** + the **Meet tab's audio** (the other
> participants) into one playable file — **without** ticking "Share system audio"?

The other participants' voice comes from `chrome.tabCapture` (automatic, no
checkbox), mixed with `getDisplayMedia` entire-screen video. If the recording
plays back WITH the tab audio, Design B works and I wire it into the real
recorder (screen-only picker via `desktopCapture(['screen'])` added there).

## How to test (2 minutes, on your machine)

1. Open `chrome://extensions` → turn on **Developer mode** (top-right).
2. Click **Load unpacked** → select this folder
   (`apps/browser-extension/_proto-screen-tabaudio`).
3. Open a tab that **plays audio**: a Google Meet call, or just a YouTube video.
   Keep that tab active and make sure sound is actually playing.
4. Click the extension icon → **Start test on THIS tab**.
5. A new "recorder" tab opens and asks for a screen. Choose **Entire Screen** →
   Share. (No "share audio" checkbox needed — leave it however it is.)
6. It records ~12s while the source tab plays audio, then shows a video.
7. **Press play on that video. Do you HEAR the tab's audio?**

## Report back

- ✅ **Video plays AND you hear the tab audio** → Design B works, I build it for real.
- ❌ **No audio**, or an error message on the page → copy the red error text (or
  say "no audio") so I can adjust.

Delete this folder after we decide.
