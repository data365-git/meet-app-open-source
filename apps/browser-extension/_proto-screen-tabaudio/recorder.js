// Proves the make-or-break unknown for Design B:
//   entire-screen VIDEO (getDisplayMedia, in this real tab) + Meet-tab AUDIO
//   (tabCapture streamId minted by the SW, consumed HERE) → mixed → one playable
//   file, remote audio present, WITHOUT any "share system audio" tick.

const statusEl = document.getElementById("status");
const setStatus = (t, err) => {
	statusEl.textContent = t;
	statusEl.className = err ? "err" : "";
};

(async () => {
	// 1) Ask the SW for a tab-audio streamId consumable by THIS tab.
	const resp = await chrome.runtime.sendMessage({ type: "RECORDER_READY" });
	if (!resp || resp.error) {
		setStatus("Could not mint tab audio: " + (resp && resp.error), true);
		return;
	}

	// 2) Consume the Meet-tab AUDIO (no picker, no checkbox — this is the point).
	let tabAudio;
	try {
		tabAudio = await navigator.mediaDevices.getUserMedia({
			audio: {
				mandatory: {
					chromeMediaSource: "tab",
					chromeMediaSourceId: resp.streamId,
				},
			},
			video: false,
		});
	} catch (e) {
		setStatus("Tab audio getUserMedia failed: " + e.message, true);
		return;
	}

	// 3) Entire-screen VIDEO (user picks Entire Screen; audio:false — we do NOT
	//    rely on system audio at all).
	let screen;
	try {
		screen = await navigator.mediaDevices.getDisplayMedia({
			video: true,
			audio: false,
		});
	} catch (e) {
		setStatus("Screen capture cancelled/failed: " + e.message, true);
		tabAudio.getTracks().forEach((t) => t.stop());
		return;
	}

	// 4) Mix: tab audio → recording, and also back to speakers so the meeting
	//    stays audible (tabCapture otherwise mutes the tab).
	const ctx = new AudioContext();
	const dest = ctx.createMediaStreamDestination();
	const src = ctx.createMediaStreamSource(tabAudio);
	src.connect(dest);
	src.connect(ctx.destination);

	const mixed = new MediaStream([
		...screen.getVideoTracks(),
		...dest.stream.getAudioTracks(),
	]);

	const rec = new MediaRecorder(mixed, { mimeType: "video/webm" });
	const chunks = [];
	rec.ondataavailable = (e) => {
		if (e.data.size) chunks.push(e.data);
	};
	rec.onstop = () => {
		screen.getTracks().forEach((t) => t.stop());
		tabAudio.getTracks().forEach((t) => t.stop());
		ctx.close().catch(() => {});
		const blob = new Blob(chunks, { type: "video/webm" });
		document.getElementById("playback").src = URL.createObjectURL(blob);
		setStatus(
			`Done (${(blob.size / 1024).toFixed(0)} KB). Press play — do you HEAR the tab audio?`,
		);
	};

	// Stop when the user ends screen-share, on the button, or after 12s.
	const vt = screen.getVideoTracks()[0];
	if (vt) vt.onended = () => rec.state !== "inactive" && rec.stop();
	document.getElementById("stop").onclick = () =>
		rec.state !== "inactive" && rec.stop();

	rec.start();
	setStatus("Recording ~12s — make sure the source tab is playing audio…");
	setTimeout(() => rec.state !== "inactive" && rec.stop(), 12000);
})().catch((e) => setStatus("Unexpected error: " + e.message, true));
