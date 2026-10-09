// Control panel for the spike. Stays open (visible tab), renders the live log
// broadcast by the SW + offscreen doc, and plays back the recorded file.

const runBtn = document.getElementById("run");
const logEl = document.getElementById("log");
const resultEl = document.getElementById("result");
const verdictEl = document.getElementById("verdict");

let step4Passed = null; // the make-or-break: offscreen getDisplayMedia

function addLog({ step, ok, detail }) {
	const li = document.createElement("li");
	li.className = ok ? "ok" : "fail";
	li.innerHTML =
		`<span class="badge">${ok ? "✓" : "✗"}</span>` +
		`<span class="step"></span><span class="detail"></span>`;
	li.querySelector(".step").textContent = step;
	li.querySelector(".detail").textContent = detail || "";
	logEl.appendChild(li);

	if (step.startsWith("4.")) {
		step4Passed = ok;
		showVerdict();
	}
}

function showVerdict() {
	if (step4Passed === true) {
		verdictEl.className = "verdict pass";
		verdictEl.textContent =
			"✓ VERDICT: offscreen getDisplayMedia RESOLVED → Design B is viable. Now confirm the playback below (screen + remote voice + mic, no echo).";
	} else if (step4Passed === false) {
		verdictEl.className = "verdict fail";
		verdictEl.textContent =
			"✗ VERDICT: offscreen getDisplayMedia FAILED → fall back to Design A′ (dedicated visible recorder tab).";
	}
}

function showVideo({ dataUrl, mime, size }) {
	resultEl.innerHTML = "";
	const v = document.createElement("video");
	v.controls = true;
	v.src = dataUrl;
	resultEl.appendChild(v);
	const a = document.createElement("a");
	a.className = "dl";
	a.href = dataUrl;
	a.download = `spike-recording.${mime.includes("mp4") ? "mp4" : "webm"}`;
	a.textContent = `⬇ Download recording (${(size / 1024).toFixed(0)} KB)`;
	resultEl.appendChild(a);
	runBtn.disabled = false;
	runBtn.textContent = "▶ Run again";
}

chrome.runtime.onMessage.addListener((msg) => {
	if (msg?.type === "PROTO_LOG") addLog(msg);
	else if (msg?.type === "PROTO_VIDEO") showVideo(msg);
	return false;
});

runBtn.addEventListener("click", () => {
	logEl.innerHTML = "";
	resultEl.innerHTML = "";
	verdictEl.className = "verdict";
	step4Passed = null;
	runBtn.disabled = true;
	runBtn.textContent = "Running… (pick a screen in the popup)";
	chrome.runtime.sendMessage({ type: "RUN_TEST" }).catch((err) => {
		addLog({ step: "RUN_TEST", ok: false, detail: err.message });
		runBtn.disabled = false;
		runBtn.textContent = "▶ Run capture test";
	});
});
