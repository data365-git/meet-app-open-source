document.getElementById("start").addEventListener("click", async () => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab) {
		document.getElementById("msg").textContent = "No active tab.";
		return;
	}
	await chrome.runtime.sendMessage({ type: "START", targetTabId: tab.id });
	window.close();
});
