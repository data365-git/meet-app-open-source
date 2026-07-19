// The heart of the spike. Runs inside the offscreen document created with
// reasons [DISPLAY_MEDIA, USER_MEDIA]. Mirrors the production mix recipe
// (recorder.ts) but records ~6s and ships the result to proto.html.

const RECORD_MS = 6000;

function log(step, ok, detail) {
	chrome.runtime.sendMessage({ type: "PROTO_LOG", step, ok, detail }).catch(() => {});
}

function pickMimeType() {
	const candidates = [
		"video/mp4;codecs=h264",
		"video/mp4",
		"video/webm;codecs=vp9,opus",
		"video/webm;codecs=vp8,opus",
		"video/webm",
	];
	for (const mime of candidates) {
		if (MediaRecorder.isTypeSupported(mime)) return mime;
	}
	return "video/webm";
}

async function startCapture(streamId) {
	let displayStream = null;
	let tabAudioStream = null;
	let micStream = null;
	let audioCtx = null;

	try {
		// ── STEP 1 — the make-or-break: getDisplayMedia from OFFSCREEN ──────────
		try {
			displayStream = await navigator.mediaDevices.getDisplayMedia({
				video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 24 } },
				audio: false,
			});
			log("4. getDisplayMedia (offscreen)", true, "PICKER RESOLVED ✓ — offscreen getDisplayMedia WORKS. Design B is viable.");
		} catch (err) {
			const name = err instanceof Error ? err.name : "";
			log(
				"4. getDisplayMedia (offscreen)",
				false,
				`FAILED (${name}): ${err.message}. If "InvalidStateError/user gesture" -> Design B dead, use fallback A′.`,
			);
			return;
		}

		// ── STEP 2 — redeem the tab-audio id in the SAME context (coexistence) ──
		try {
			tabAudioStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
				},
			});
			const n = tabAudioStream.getAudioTracks().length;
			log("5. Redeem tab audio", n > 0, n > 0
				? `${n} tab-audio track live ALONGSIDE the display track ✓`
				: "getUserMedia returned 0 audio tracks.");
		} catch (err) {
			log("5. Redeem tab audio", false, `FAILED: ${err.message}. (Id expired? Tab has no audio?)`);
			// Keep going — screen video + mic still proves step 1.
		}

		// ── STEP 3 — mic ───────────────────────────────────────────────────────
		try {
			micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			log("6. Mic", true, "Mic captured ✓");
		} catch (err) {
			micStream = null;
			log("6. Mic", false, `No mic: ${err.message}`);
		}

		// ── Mix (same AudioContext recipe as recorder.ts) ──────────────────────
		audioCtx = new AudioContext({ sampleRate: 48000 });
		const dest = audioCtx.createMediaStreamDestination();
		if (tabAudioStream && tabAudioStream.getAudioTracks().length > 0) {
			const src = audioCtx.createMediaStreamSource(tabAudioStream);
			src.connect(dest);
			// Route tab audio back to speakers so the meeting stays audible.
			// Safe here: the offscreen replay context is NOT itself captured -> no echo.
			src.connect(audioCtx.destination);
		}
		if (micStream && micStream.getAudioTracks().length > 0) {
			audioCtx.createMediaStreamSource(micStream).connect(dest);
		}

		const recordStream = new MediaStream([
			...displayStream.getVideoTracks(),
			...dest.stream.getAudioTracks(),
		]);

		const mime = pickMimeType();
		const recorder = new MediaRecorder(recordStream, {
			mimeType: mime,
			videoBitsPerSecond: 600_000,
			audioBitsPerSecond: 96_000,
		});
		const chunks = [];
		recorder.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) chunks.push(e.data);
		};
		recorder.onstop = async () => {
			try {
				const blob = new Blob(chunks, { type: mime });
				const dataUrl = await new Promise((res, rej) => {
					const fr = new FileReader();
					fr.onload = () => res(fr.result);
					fr.onerror = () => rej(fr.error);
					fr.readAsDataURL(blob);
				});
				log("8. Recording finished", true, `${(blob.size / 1024).toFixed(0)} KB, ${mime}. Playing below — check: screen visible, remote audible, mic audible, NO echo.`);
				chrome.runtime.sendMessage({ type: "PROTO_VIDEO", dataUrl, mime, size: blob.size }).catch(() => {});
			} catch (err) {
				log("8. Recording finished", false, `Blob/encode failed: ${err.message}`);
			} finally {
				cleanup();
			}
		};

		// Stop when the user ends the screen share early.
		const vt = displayStream.getVideoTracks()[0];
		if (vt) vt.onended = () => { if (recorder.state !== "inactive") recorder.stop(); };

		recorder.start(200);
		log("7. Recording…", true, `Recording ${RECORD_MS / 1000}s — talk into your mic and keep the meeting playing.`);
		setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, RECORD_MS);
	} catch (err) {
		log("ERROR", false, err instanceof Error ? err.message : String(err));
		cleanup();
	}

	function cleanup() {
		for (const s of [displayStream, tabAudioStream, micStream]) {
			if (s) for (const t of s.getTracks()) t.stop();
		}
		if (audioCtx && audioCtx.state !== "closed") audioCtx.close().catch(() => {});
	}
}

chrome.runtime.onMessage.addListener((msg) => {
	if (msg?.type === "START_CAPTURE") startCapture(msg.streamId);
	return false;
});
