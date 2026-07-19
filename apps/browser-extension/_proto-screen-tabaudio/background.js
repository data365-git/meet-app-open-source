// Throwaway spike SW. Flow:
//  1) popup (on the Meet/audible tab) sends START with that tab's id.
//  2) we open recorder.html in a NEW tab and remember both ids.
//  3) recorder.html sends RECORDER_READY; we mint a tabCapture streamId for the
//     ORIGINAL tab, consumable by the recorder tab, and hand it back.
// The key thing being proven: a tabCapture streamId (Meet-tab AUDIO) can be
// consumed in a DIFFERENT tab and mixed with getDisplayMedia screen video.

let pending = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg.type === "START") {
		chrome.tabs.create(
			{ url: chrome.runtime.getURL("recorder.html"), active: true },
			(tab) => {
				pending = { targetTabId: msg.targetTabId };
				console.log("[proto] recorder tab", tab.id, "target", msg.targetTabId);
				sendResponse({ ok: true });
			},
		);
		return true; // async sendResponse
	}

	if (msg.type === "RECORDER_READY") {
		if (!pending) {
			sendResponse({ error: "no pending capture" });
			return false;
		}
		// consumerTabId MUST be the recorder tab that will call getUserMedia.
		chrome.tabCapture.getMediaStreamId(
			{ targetTabId: pending.targetTabId, consumerTabId: sender.tab.id },
			(streamId) => {
				const err = chrome.runtime.lastError;
				if (err || !streamId) {
					sendResponse({ error: err ? err.message : "no streamId" });
					return;
				}
				console.log("[proto] minted streamId for consumer", sender.tab.id);
				sendResponse({ streamId });
			},
		);
		return true; // async sendResponse
	}

	return false;
});
