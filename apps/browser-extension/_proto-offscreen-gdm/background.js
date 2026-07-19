// Throwaway spike SW. Orchestrates the make-or-break test:
//   proto.html button click -> RUN_TEST -> SW mints a tabCapture id for an
//   audible tab -> creates offscreen with reasons [DISPLAY_MEDIA, USER_MEDIA]
//   -> posts START_CAPTURE. The offscreen doc does the actual getDisplayMedia.
// All progress is broadcast as PROTO_LOG messages that proto.html renders.

function log(step, ok, detail) {
	chrome.runtime
		.sendMessage({ type: "PROTO_LOG", step, ok, detail })
		.catch(() => {});
}

// Mint a serializable tab-capture stream id (same call the real extension uses).
function getTabMediaStreamId(targetTabId) {
	return new Promise((resolve, reject) => {
		try {
			chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
				if (chrome.runtime.lastError) {
					reject(new Error(chrome.runtime.lastError.message));
				} else if (!streamId) {
					reject(new Error("tabCapture returned no stream id"));
				} else {
					resolve(streamId);
				}
			});
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

async function ensureOffscreen() {
	const existing = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});
	if (existing.length > 0) {
		await chrome.offscreen.closeDocument().catch(() => {});
	}
	// THE key line under test: DISPLAY_MEDIA reason is Chrome's sanctioned way
	// to allow getDisplayMedia inside an offscreen document.
	await chrome.offscreen.createDocument({
		url: "offscreen.html",
		reasons: [
			chrome.offscreen.Reason.DISPLAY_MEDIA,
			chrome.offscreen.Reason.USER_MEDIA,
		],
		justification: "Spike: screen video + tab audio + mic in one context",
	});
}

// Pick a tab whose audio we can capture. Prefer an audible tab (a Meet with a
// second participant, or any YouTube/video tab), so step 2 has real audio.
async function pickAudioTab() {
	const audible = await chrome.tabs.query({ audible: true });
	if (audible.length > 0 && audible[0].id != null) return audible[0];
	// Fall back to the active tab in the last focused normal window.
	const [active] = await chrome.tabs.query({
		active: true,
		lastFocusedWindow: true,
	});
	return active ?? null;
}

async function runTest() {
	try {
		log("0. Reset", true, "Starting a fresh test run.");

		const tab = await pickAudioTab();
		if (!tab || tab.id == null) {
			log("1. Pick tab", false, "No capturable tab found. Open a Meet/YouTube tab first.");
			return;
		}
		const audibleNote = tab.audible ? " (audible ✓)" : " (NOT audible — audio may be silent)";
		log("1. Pick tab", true, `Capturing audio from: "${tab.title || tab.url}"${audibleNote}`);

		let streamId;
		try {
			streamId = await getTabMediaStreamId(tab.id);
			log("2. Mint tabCapture id", true, "Got a stream id (single-use, expires fast).");
		} catch (err) {
			log("2. Mint tabCapture id", false, `getMediaStreamId failed: ${err.message}. (Gesture/permission?)`);
			return;
		}

		try {
			await ensureOffscreen();
			log("3. Create offscreen [DISPLAY_MEDIA]", true, "Offscreen document created with DISPLAY_MEDIA reason.");
		} catch (err) {
			log("3. Create offscreen [DISPLAY_MEDIA]", false, `createDocument failed: ${err.message}`);
			return;
		}

		// Hand off. Offscreen does getDisplayMedia + redeems the audio id + mixes.
		chrome.runtime
			.sendMessage({ type: "START_CAPTURE", streamId })
			.catch((err) => log("4. Hand off to offscreen", false, err.message));
	} catch (err) {
		log("ERROR", false, err instanceof Error ? err.message : String(err));
	}
}

chrome.action.onClicked.addListener(async () => {
	const url = chrome.runtime.getURL("proto.html");
	const existing = await chrome.tabs.query({ url });
	if (existing.length > 0 && existing[0].id != null) {
		await chrome.tabs.update(existing[0].id, { active: true });
	} else {
		await chrome.tabs.create({ url, active: true });
	}
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg?.type === "RUN_TEST") {
		runTest();
		sendResponse({ ok: true });
	}
	return false;
});
