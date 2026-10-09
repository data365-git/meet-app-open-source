import type { ExtensionSettings, ExtensionState } from "../background/state";
import { sendCaptureCommand } from "../shared/capture-command";
import { DEFAULT_API_BASE_URL } from "../shared/config";
import { populateDeviceSelect } from "../shared/device-picker";
import { getMeetingId } from "../shared/meeting-url";
import { attachFlash, type FlashState, NO_FLASH, reconcileFlash } from "./flash-message";

interface PopupData {
	state: ExtensionState;
	settings: ExtensionSettings;
	isMeetTab: boolean;
	meetingId: string | null;
	activeTabId: number | undefined;
}

let timerInterval: ReturnType<typeof setInterval> | null = null;
// The data render() last drew, and the honest one-line message layered over it.
// Both live at module scope so an async reply (pause failure, discard result) can
// fold its message into RENDERED STATE and re-render, instead of appending a node
// to a root the next ~5/s re-render has already detached. See flash-message.ts.
let currentData: PopupData | null = null;
let flash: FlashState = NO_FLASH;
let micStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let meterRaf: number | null = null;
const PENDING_MEET_START_KEY = "capPendingMeetStart";
const PENDING_MEET_START_TTL_MS = 15000;

interface PendingMeetStart {
	tabId?: number;
	meetingId?: string;
	createdAt?: number;
}

function stopTimer(): void {
	if (timerInterval !== null) {
		clearInterval(timerInterval);
		timerInterval = null;
	}
}

function teardownMic(): void {
	if (meterRaf !== null) {
		cancelAnimationFrame(meterRaf);
		meterRaf = null;
	}
	if (analyser) {
		analyser.disconnect();
		analyser = null;
	}
	if (audioCtx) {
		audioCtx.close().catch(() => {});
		audioCtx = null;
	}
	if (micStream) {
		for (const track of micStream.getTracks()) track.stop();
		micStream = null;
	}
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (key === "className") {
			node.className = value as string;
		} else {
			(node as unknown as Record<string, unknown>)[key] = value;
		}
	}
	for (const child of children) {
		if (typeof child === "string") {
			node.appendChild(document.createTextNode(child));
		} else {
			node.appendChild(child);
		}
	}
	return node;
}

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const hh = String(h).padStart(2, "0");
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function sendMsg(msg: Record<string, unknown>): void {
	chrome.runtime.sendMessage(msg, () => {
		if (chrome.runtime.lastError) {
		}
	});
}

function sendMsgAwait(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(msg, (response: unknown) => {
			if (chrome.runtime.lastError) {
				resolve({ ok: false, error: chrome.runtime.lastError.message });
			} else if (response && typeof response === "object") {
				resolve(response as Record<string, unknown>);
			} else {
				resolve({ ok: false, error: "No response from recorder" });
			}
		});
	});
}

function createToggleEl(id: string, checked: boolean): HTMLElement {
	const label = document.createElement("label");
	label.className = "toggle";
	label.htmlFor = id;
	const input = document.createElement("input");
	input.type = "checkbox";
	input.id = id;
	input.checked = checked;
	const track = document.createElement("span");
	track.className = "toggle__track";
	const knob = document.createElement("span");
	knob.className = "toggle__knob";
	track.appendChild(knob);
	label.appendChild(input);
	label.appendChild(track);
	return label;
}

function startMicMeter(deviceId: string, bars: HTMLElement[]): void {
	teardownMic();

	const constraints: MediaStreamConstraints = deviceId
		? { audio: { deviceId: { exact: deviceId } } }
		: { audio: true };

	navigator.mediaDevices
		.getUserMedia(constraints)
		.then((stream) => {
			micStream = stream;
			audioCtx = new AudioContext();
			analyser = audioCtx.createAnalyser();
			analyser.fftSize = 256;
			const source = audioCtx.createMediaStreamSource(stream);
			source.connect(analyser);
			const data = new Uint8Array(analyser.frequencyBinCount);

			function tick(): void {
				if (!analyser) return;
				analyser.getByteFrequencyData(data);
				let sum = 0;
				for (let i = 0; i < data.length; i++) sum += data[i];
				const avg = sum / data.length;
				const level = Math.min(1, avg / 80);
				const lit = Math.round(level * bars.length);
				for (let i = 0; i < bars.length; i++) {
					bars[i].classList.toggle("mic-bar--active", i < lit);
				}
				meterRaf = requestAnimationFrame(tick);
			}

			meterRaf = requestAnimationFrame(tick);
		})
		.catch(() => {
			for (const bar of bars) bar.classList.remove("mic-bar--active");
		});
}

function buildMicMeter(): { meterEl: HTMLElement; bars: HTMLElement[] } {
	const meterEl = el("div", { className: "mic-meter" });
	const bars: HTMLElement[] = [];
	for (let i = 0; i < 7; i++) {
		const bar = el("span", { className: "mic-bar" });
		meterEl.appendChild(bar);
		bars.push(bar);
	}
	return { meterEl, bars };
}

function renderIdlePanel(
	root: HTMLElement,
	settings: ExtensionSettings,
	isMeetTab: boolean,
	meetingId: string | null,
	activeTabId: number | undefined,
): void {
	const logo = document.createElement("img");
	logo.src = "icons/icon-128.png";
	logo.width = 28;
	logo.height = 28;
	logo.alt = "data365";

	const logoLabel = el(
		"span",
		{ className: "panel-logo-label" },
		"data365 Recorder",
	);
	const logoRow = el("div", { className: "panel-logo-row" }, logo, logoLabel);
	root.appendChild(logoRow);

	const actionsSection = el("div", { className: "panel-section" });

	// On a Meet tab, "Record full-screen meeting" is the GUARANTEED path
	// (sourceTabId + meeting:true → fail-closed if the client's audio can't be
	// captured, per the owner's requirement). "Record Meet tab only" (START_MEET)
	// stays available but demoted — it records only the Meet tab, not the whole
	// screen. Off a Meet tab there is no client-audio requirement at all.
	const meetBtn = document.createElement("button");
	meetBtn.className = "btn btn-secondary";

	if (isMeetTab && meetingId) {
		meetBtn.textContent = `Record Meet tab only · ${meetingId}`;
		meetBtn.addEventListener("click", () => {
			const msg: Record<string, unknown> = { type: "START_MEET", meetingId };
			if (activeTabId !== undefined) msg.tabId = activeTabId;
			sendMsg(msg);
			window.close();
		});
	} else {
		meetBtn.textContent = "Record Meet tab only";
		meetBtn.disabled = true;
		meetBtn.classList.add("btn--disabled");
	}

	const instrBtn = el(
		"button",
		{ className: isMeetTab ? "btn btn-primary" : "btn btn-secondary" },
		isMeetTab ? "Record full-screen meeting" : "Record screen",
	);
	instrBtn.addEventListener("click", () => {
		const msg: Record<string, unknown> = { type: "START_INSTRUCTION" };
		// Only on a Meet tab: pass it so the recorder mixes in the OTHER party's
		// audio via tabCapture, and require the guarantee to fail closed rather
		// than silently record client-less. NOT for plain instruction recordings
		// from a random tab — that would silently capture whatever audio that
		// tab plays (privacy), and there is no client-audio guarantee to make.
		if (isMeetTab && activeTabId !== undefined) {
			msg.sourceTabId = activeTabId;
			msg.meeting = true;
			// So the recording files as a meeting (title "data365 Meeting — <id>",
			// extensionContext "meeting") instead of a plain instruction recording —
			// see sw.ts START_INSTRUCTION/RECORDER_STARTED.
			if (meetingId) msg.meetingId = meetingId;
		}
		sendMsg(msg);
		window.close();
	});

	actionsSection.appendChild(instrBtn);
	actionsSection.appendChild(meetBtn);

	if (!isMeetTab || !meetingId) {
		const hint = el(
			"p",
			{ className: "panel-hint" },
			"Join a Google Meet to record a meeting",
		);
		actionsSection.appendChild(hint);
	}

	root.appendChild(actionsSection);
	root.appendChild(el("div", { className: "panel-divider" }));

	const devicesSection = el("div", { className: "panel-section" });
	devicesSection.appendChild(
		el("p", { className: "panel-section-label" }, "Devices"),
	);

	let micEnabled = settings.micEnabled !== false;
	let micDeviceId = settings.micDeviceId ?? "";

	const { meterEl, bars } = buildMicMeter();

	const micSelect = document.createElement("select");
	micSelect.className = "device-select";
	micSelect.disabled = !micEnabled;

	const micToggleWrap = createToggleEl("mic-toggle", micEnabled);
	const micToggleInput = micToggleWrap.querySelector(
		"input",
	) as HTMLInputElement;

	const micEnableBtn = el(
		"button",
		{ className: "btn btn-secondary perm-btn" },
		"Enable microphone",
	);
	micEnableBtn.style.display = "none";
	micEnableBtn.addEventListener("click", () => {
		chrome.runtime.openOptionsPage();
	});

	const micRow = el(
		"div",
		{ className: "device-row" },
		el("span", { className: "device-row-label" }, "Mic"),
		micToggleWrap,
		micSelect,
		micEnableBtn,
		meterEl,
	);
	devicesSection.appendChild(micRow);

	function updateMicState(): void {
		micSelect.disabled = !micEnabled;
		if (micEnabled) {
			meterEl.classList.remove("mic-meter--off");
			startMicMeter(micDeviceId, bars);
		} else {
			meterEl.classList.add("mic-meter--off");
			teardownMic();
			for (const bar of bars) bar.classList.remove("mic-bar--active");
		}
	}

	micToggleInput.addEventListener("change", () => {
		micEnabled = micToggleInput.checked;
		sendMsg({ type: "SAVE_SETTINGS", settings: { micEnabled } });
		updateMicState();
	});

	micSelect.addEventListener("change", () => {
		micDeviceId = micSelect.value;
		sendMsg({ type: "SAVE_SETTINGS", settings: { micDeviceId } });
		if (micEnabled) startMicMeter(micDeviceId, bars);
	});

	populateDeviceSelect(micSelect, "audioinput", micDeviceId, { audio: true })
		.then((result) => {
			if (result === "blocked") {
				micSelect.style.display = "none";
				meterEl.style.display = "none";
				micToggleWrap.style.display = "none";
				micEnableBtn.style.display = "";
			} else {
				updateMicState();
			}
		})
		.catch(() => {
			meterEl.classList.add("mic-meter--off");
		});

	// Camera overlay toggle + device dropdown: HIDDEN (R4) — nothing in the
	// recording pipeline (recorder/offscreen recorder/service worker) ever
	// reads cameraOverlay/cameraDeviceId, so this control did nothing. Keeping
	// the settings fields themselves untouched; just not rendering the dead
	// UI. See CLAUDE.md R4.
	//
	// let cameraEnabled = settings.cameraOverlay;
	// let cameraDeviceId = settings.cameraDeviceId ?? "";
	//
	// const cameraSelect = document.createElement("select");
	// cameraSelect.className = "device-select";
	// cameraSelect.disabled = !cameraEnabled;
	//
	// const cameraToggleWrap = createToggleEl("camera-toggle", cameraEnabled);
	// const cameraToggleInput = cameraToggleWrap.querySelector(
	// 	"input",
	// ) as HTMLInputElement;
	//
	// const cameraEnableBtn = el(
	// 	"button",
	// 	{ className: "btn btn-secondary perm-btn" },
	// 	"Enable camera",
	// );
	// cameraEnableBtn.style.display = "none";
	// cameraEnableBtn.addEventListener("click", () => {
	// 	chrome.runtime.openOptionsPage();
	// });
	//
	// const cameraRow = el(
	// 	"div",
	// 	{ className: "device-row" },
	// 	el("span", { className: "device-row-label" }, "Camera"),
	// 	cameraToggleWrap,
	// 	cameraSelect,
	// 	cameraEnableBtn,
	// );
	// devicesSection.appendChild(cameraRow);
	//
	// cameraToggleInput.addEventListener("change", () => {
	// 	cameraEnabled = cameraToggleInput.checked;
	// 	cameraSelect.disabled = !cameraEnabled;
	// 	sendMsg({
	// 		type: "SAVE_SETTINGS",
	// 		settings: { cameraOverlay: cameraEnabled },
	// 	});
	// });
	//
	// cameraSelect.addEventListener("change", () => {
	// 	cameraDeviceId = cameraSelect.value;
	// 	sendMsg({ type: "SAVE_SETTINGS", settings: { cameraDeviceId } });
	// });
	//
	// populateDeviceSelect(cameraSelect, "videoinput", cameraDeviceId, {
	// 	video: true,
	// })
	// 	.then((result) => {
	// 		if (result === "blocked") {
	// 			cameraSelect.style.display = "none";
	// 			cameraToggleWrap.style.display = "none";
	// 			cameraEnableBtn.style.display = "";
	// 		}
	// 	})
	// 	.catch(() => {});

	root.appendChild(devicesSection);
	root.appendChild(el("div", { className: "panel-divider" }));

	const footer = el("div", { className: "panel-footer" });
	const settingsLink = el("button", { className: "link-btn" }, "Settings");
	settingsLink.addEventListener("click", () => {
		chrome.runtime.openOptionsPage();
	});
	footer.appendChild(settingsLink);
	root.appendChild(footer);
}

function renderNotSignedIn(
	root: HTMLElement,
	settings: ExtensionSettings,
): void {
	const logoWrap = el(
		"div",
		{ className: "logo-wrap" },
		el("img", {
			src: "icons/icon-128.png",
			width: 48,
			height: 48,
			alt: "data365",
		} as unknown as Partial<HTMLImageElement>),
		el("h1", {}, "data365 Recorder"),
	);

	// ── PRIMARY: OAuth button ──────────────────────────────────────────────
	const signInBtn = el(
		"button",
		{ className: "btn btn-primary" },
		"Sign in with data365",
	);

	const oauthMsg = el("p", { className: "inline-msg" });

	signInBtn.addEventListener("click", () => {
		oauthMsg.textContent = "Opening sign-in…";
		oauthMsg.style.color = "";
		chrome.runtime.sendMessage({ type: "START_SIGNIN" }, (resp) => {
			if (chrome.runtime.lastError) return; // popup may have closed; SW still finishes
			const ok = typeof resp === "object" && resp !== null && (resp as { ok?: boolean }).ok === true;
			if (ok) {
				location.reload();
			} else {
				oauthMsg.textContent = "Couldn't sign in automatically — paste your key below instead";
				oauthMsg.style.color = "#e53e3e";
			}
		});
	});

	// ── SECONDARY: API-key paste (always visible) ─────────────────────────
	const keyDivider = el(
		"p",
		{ className: "inline-msg" },
		"— or paste your API key —",
	);
	keyDivider.style.textAlign = "center";
	keyDivider.style.color = "#888";
	keyDivider.style.margin = "6px 0 2px";

	const keyHint = el(
		"p",
		{ className: "inline-msg" },
		"Find your key at: data365 server → /extension/callback",
	);
	keyHint.style.fontSize = "11px";
	keyHint.style.color = "#888";
	keyHint.style.margin = "0 0 4px";

	const apiKeyInput = el("input", {
		className: "api-key-input",
		type: "text",
		placeholder: "Paste your cak_... key here",
	} as unknown as Partial<HTMLInputElement>);

	const connectBtn = el(
		"button",
		{ className: "btn btn-secondary" },
		"Connect with key",
	);

	const inlineMsg = el("p", { className: "inline-msg" });

	connectBtn.addEventListener("click", async () => {
		const key = (apiKeyInput as HTMLInputElement).value.trim();
		if (!key) {
			inlineMsg.textContent = "Please paste a key";
			inlineMsg.style.color = "#e53e3e";
			return;
		}
		inlineMsg.textContent = "";
		connectBtn.disabled = true;
		connectBtn.textContent = "Verifying...";
		chrome.runtime.sendMessage(
			{
				type: "SAVE_SETTINGS",
				settings: { apiKey: key, apiBaseUrl: settings.apiBaseUrl },
			},
			async () => {
				// Fix #4: bail out if the save itself failed
				if (chrome.runtime.lastError) {
					inlineMsg.textContent = "Couldn't save key — try again";
					inlineMsg.style.color = "#e53e3e";
					connectBtn.disabled = false;
					connectBtn.textContent = "Connect with key";
					return;
				}
				try {
					const res = await fetch(`${settings.apiBaseUrl}/api/extension/me`, {
						headers: { Authorization: `Bearer ${key}` },
					});
					if (res.ok) {
						const data = (await res.json().catch(() => ({}))) as Record<
							string,
							unknown
						>;
						const name =
							typeof data.name === "string"
								? data.name
								: typeof data.email === "string"
									? data.email
									: "";
						if (name) {
							inlineMsg.textContent = `Connected as ${name}`;
							inlineMsg.style.color = "#38a169";
						}
						setTimeout(() => location.reload(), 800);
					} else if (res.status === 401) {
						inlineMsg.textContent =
							"Key not accepted — sign in again or paste a new key";
						inlineMsg.style.color = "#e53e3e";
						connectBtn.disabled = false;
						connectBtn.textContent = "Connect with key";
						chrome.runtime.sendMessage({
							type: "SAVE_SETTINGS",
							settings: { apiKey: "", apiBaseUrl: settings.apiBaseUrl },
						});
					} else {
						inlineMsg.textContent = `Server error (${res.status}) — try again`;
						inlineMsg.style.color = "#e53e3e";
						connectBtn.disabled = false;
						connectBtn.textContent = "Connect with key";
						chrome.runtime.sendMessage({
							type: "SAVE_SETTINGS",
							settings: { apiKey: "", apiBaseUrl: settings.apiBaseUrl },
						});
					}
				} catch {
					inlineMsg.textContent =
						"Can't reach the server — check the address in Settings";
					inlineMsg.style.color = "#e53e3e";
					connectBtn.disabled = false;
					connectBtn.textContent = "Connect with key";
					chrome.runtime.sendMessage({
						type: "SAVE_SETTINGS",
						settings: { apiKey: "", apiBaseUrl: settings.apiBaseUrl },
					});
				}
			},
		);
	});

	root.appendChild(logoWrap);
	root.appendChild(signInBtn);
	root.appendChild(oauthMsg);
	root.appendChild(keyDivider);
	root.appendChild(keyHint);
	root.appendChild(apiKeyInput);
	root.appendChild(connectBtn);
	root.appendChild(inlineMsg);
}

// Elapsed recording time, EXCLUDING paused spans. While paused it freezes on
// the moment pause began; after resume it excludes the accumulated paused time
// — so the timer matches the actual recorded media (which also excludes pauses).
function recordingElapsedMs(
	state: Extract<ExtensionState, { kind: "recording" }>,
): number {
	const ref = state.paused ? (state.pausedAt ?? Date.now()) : Date.now();
	return Math.max(0, ref - state.startedAt - (state.pausedAccumMs ?? 0));
}

function renderRecording(
	root: HTMLElement,
	state: Extract<ExtensionState, { kind: "recording" }>,
): void {
	stopTimer();

	const header = el(
		"div",
		{ className: "recording-header" },
		el("span", { className: "rec-dot" }),
		el("span", { className: "rec-label" }, "Recording"),
	);

	const timerEl = el(
		"div",
		{ className: "timer" },
		formatElapsed(recordingElapsedMs(state)),
	);

	// state.mode stays "instruction" for the guaranteed full-screen meeting flow
	// (it is the STOP/PAUSE/RESUME/CANCEL control-flow discriminator and must
	// not change) — branch on meetingRequired too so that flow still LABELS as
	// "Meeting" instead of misleadingly showing "Instruction".
	const isMeeting = state.mode === "meeting" || state.meetingRequired === true;
	const modeEl = el(
		"p",
		{ className: "mode-label" },
		isMeeting ? "Meeting" : "Instruction",
	);

	const pauseLabel = state.paused ? "Resume" : "Pause";
	const pauseBtn = el("button", { className: "btn btn-secondary" }, pauseLabel);
	pauseBtn.addEventListener("click", () => {
		void (async () => {
			const command = state.paused ? "RESUME" : "PAUSE";
			pauseBtn.disabled = true;
			pauseBtn.textContent = command === "PAUSE" ? "Pausing..." : "Resuming...";
			// AWAIT the answer. This used to fire-and-forget and re-enable itself on
			// a fixed 200ms timer — shorter than the SW's own retry budget, so the
			// button went live while the command was still retrying, and a command
			// the SW reported as FAILED ({ok:false}, recorder never paused) was
			// indistinguishable from one that worked.
			const result = await sendCaptureCommand(sendMsgAwait, command);
			if (result.ok) {
				// setState in the SW broadcasts STATE_CHANGED and the whole view
				// re-renders from truth. The paused flag flips, which reconcileFlash
				// treats as a transition and clears any prior failure line.
				return;
			}
			// Do NOT move to the new state. Put the reason into RENDERED STATE so the
			// ~5/s recording re-render REDRAWS it, instead of appending a node to a
			// root that a re-render has already detached (the wave-1 bug: the error
			// was never seen). showFlash re-renders, which also restores the button
			// to "Pause"/"Resume", enabled, from the unchanged state.
			showFlash({ text: result.error, isError: true });
		})();
	});

	const stopBtn = el("button", { className: "btn btn-danger" }, "Stop");
	stopBtn.addEventListener("click", () => {
		stopBtn.disabled = true;
		stopBtn.textContent = "Finishing...";
		pauseBtn.disabled = true;
		sendMsg({ type: "STOP" });
	});

	const btnRow = el("div", { className: "btn-row" }, pauseBtn, stopBtn);

	root.appendChild(header);
	root.appendChild(timerEl);
	root.appendChild(modeEl);
	root.appendChild(btnRow);

	timerInterval = setInterval(() => {
		timerEl.textContent = formatElapsed(recordingElapsedMs(state));
	}, 1000);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderUploading(
	root: HTMLElement,
	state: Extract<ExtensionState, { kind: "uploading" }>,
): void {
	const wrap = el("div", { className: "uploading-wrap" });

	const title = el("p", { className: "uploading-title" }, "Uploading...");
	const spinner = el("div", { className: "spinner" });

	const pct =
		state.totalBytes > 0
			? Math.round((state.uploadedBytes / state.totalBytes) * 100)
			: 0;
	const progressText = `${formatBytes(state.uploadedBytes)} uploaded (${pct}%)`;
	const partsEl = el("p", { className: "parts-count" }, progressText);

	// TWO DISTINCT ACTIONS. This used to be a single "Cancel upload" link, which
	// was a false promise in both directions: it destroyed the finalize for the
	// user who only wanted the popup gone (the upload deliberately parks here for
	// up to ~2h across an offline spell, and every byte is already durable), and
	// it did NOT actually delete anything server-side for the user who really did
	// want it gone. Closing is now the default and non-destructive; deleting is
	// explicit and confirmed.
	const closeBtn = el(
		"button",
		{ className: "btn btn-primary" },
		"Close — upload continues in the background",
	);
	closeBtn.addEventListener("click", () => {
		window.close();
	});

	const discardBtn = el(
		"button",
		{ className: "link-btn link-btn--danger" },
		"Permanently discard",
	);
	// Step two of two. Deliberately in-place rather than a confirm() dialog: the
	// popup closes the moment it loses focus, which would dismiss a native modal.
	discardBtn.addEventListener("click", () => {
		if (discardBtn.dataset.confirming === "1") {
			discardBtn.textContent = "Discarding...";
			discardBtn.disabled = true;
			// AWAIT the reply. Fire-and-forget left "Discarding..." on screen forever
			// and, worse, would have had to claim success blind. Only two honest
			// endings exist: the server side is provably clean, or the cleanup is
			// queued and will retry. Never an unconditional "Deleted".
			void sendMsgAwait({ type: "DISCARD_UPLOAD" }).then((res) => {
				// Into RENDERED STATE, not this button's label: the uploading view
				// re-renders on every progress broadcast, which replaced the button
				// (and its result text) with a fresh "Permanently discard" before the
				// user could read it. showFlash survives those re-renders.
				//
				// Render exactly the outcome the reply names — never more (W3c). The
				// reply distinguishes three real endings: "deleted" (server provably
				// clean), "queued" (a durable retry is genuinely pending), and "noop"
				// (the upload already moved on, so nothing was attempted or queued).
				// Fall back to deriving the outcome from ok/serverCleaned for any
				// reply that predates the explicit field — but never fold the "noop"
				// (ok === false) case into "queued", which was the false promise.
				const outcome =
					res.outcome === "deleted" ||
					res.outcome === "queued" ||
					res.outcome === "noop"
						? res.outcome
						: res.ok === true
							? res.serverCleaned === true
								? "deleted"
								: "queued"
							: "noop";
				showFlash({
					text:
						outcome === "deleted"
							? "Deleted"
							: outcome === "queued"
								? "Delete queued; will retry"
								: "Nothing to delete — this recording already moved on",
					isError: false,
				});
			});
			return;
		}
		discardBtn.dataset.confirming = "1";
		discardBtn.textContent = "Tap again to delete this recording for good";
	});

	wrap.appendChild(title);
	wrap.appendChild(spinner);
	wrap.appendChild(partsEl);
	wrap.appendChild(closeBtn);
	wrap.appendChild(discardBtn);
	root.appendChild(wrap);
}

function renderFinishing(root: HTMLElement): void {
	const wrap = el("div", { className: "uploading-wrap" });
	const title = el("p", { className: "uploading-title" }, "Finishing up...");
	const spinner = el("div", { className: "spinner" });
	wrap.appendChild(title);
	wrap.appendChild(spinner);
	root.appendChild(wrap);
}

function renderComplete(
	root: HTMLElement,
	state: Extract<ExtensionState, { kind: "complete" }>,
): void {
	const wrap = el("div", { className: "complete-wrap" });

	const check = el("div", { className: "complete-icon" }, "✓");
	const title = el("p", { className: "complete-title" }, "Recording saved!");

	const linkEl = el("p", { className: "share-url" }, state.shareUrl);

	const btnRow = el("div", { className: "btn-row" });

	const copyBtn = el("button", { className: "btn btn-primary" }, "Copy link");
	copyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(state.shareUrl).then(() => {
			copyBtn.textContent = "Copied!";
			setTimeout(() => {
				copyBtn.textContent = "Copy link";
			}, 2000);
		});
	});

	const openBtn = el("button", { className: "btn btn-secondary" }, "Open");
	openBtn.addEventListener("click", () => {
		chrome.tabs.create({ url: state.shareUrl });
	});

	const doneBtn = el("button", { className: "link-btn" }, "Done");
	doneBtn.addEventListener("click", () => {
		sendMsg({ type: "CANCEL" });
	});

	btnRow.appendChild(copyBtn);
	btnRow.appendChild(openBtn);

	wrap.appendChild(check);
	wrap.appendChild(title);
	wrap.appendChild(linkEl);
	wrap.appendChild(btnRow);
	wrap.appendChild(doneBtn);
	root.appendChild(wrap);
}

function renderError(
	root: HTMLElement,
	state: Extract<ExtensionState, { kind: "error" }>,
): void {
	const wrap = el("div", { className: "error-wrap" });

	const icon = el("div", { className: "error-icon" }, "⚠️");
	const msg = el("p", { className: "error-msg" }, state.reason);

	wrap.appendChild(icon);
	wrap.appendChild(msg);

	if (state.recoverable) {
		const retryBtn = el("button", { className: "btn btn-primary" }, "Retry");
		retryBtn.addEventListener("click", () => {
			sendMsg({ type: "RETRY" });
		});
		wrap.appendChild(retryBtn);
	}

	const dismissBtn = el(
		"button",
		{ className: "btn btn-secondary" },
		"Dismiss",
	);
	dismissBtn.addEventListener("click", () => {
		sendMsg({ type: "CANCEL" });
	});
	wrap.appendChild(dismissBtn);

	root.appendChild(wrap);
}

function renderArming(root: HTMLElement): void {
	const msg = el("p", { className: "footnote" }, "Starting recording...");
	root.appendChild(msg);
}

// Fold an async reply's honest message into RENDERED STATE, then re-render so it
// is drawn as part of the popup rather than appended to a soon-detached root.
function showFlash(message: { text: string; isError: boolean }): void {
	if (!currentData) return;
	flash = attachFlash(currentData.state, message);
	render(currentData);
}

// The single entry point for a new app-state from the SW: drop a now-stale flash
// (its state has transitioned), record the state, and re-render.
function applyState(newState: ExtensionState): void {
	if (!currentData) return;
	flash = reconcileFlash(flash, newState);
	currentData = { ...currentData, state: newState };
	render(currentData);
}

function render(data: PopupData): void {
	stopTimer();
	teardownMic();

	currentData = data;

	const root = document.getElementById("root");
	if (!root) return;

	root.innerHTML = "";

	const popup = el("div", { className: "popup popup-content popup-content--entering" });

	const { state, settings, isMeetTab, meetingId, activeTabId } = data;
	const signedIn = settings.apiKey.length > 0;

	if (!signedIn) {
		renderNotSignedIn(popup, settings);
	} else if (state.kind === "recording") {
		renderRecording(popup, state);
	} else if (state.kind === "uploading") {
		renderUploading(popup, state);
	} else if (state.kind === "finishing") {
		renderFinishing(popup);
	} else if (state.kind === "complete") {
		renderComplete(popup, state);
	} else if (state.kind === "error") {
		renderError(popup, state);
	} else if (state.kind === "arming") {
		renderArming(popup);
	} else {
		renderIdlePanel(popup, settings, isMeetTab, meetingId, activeTabId);
	}

	// Drawn on every rebuild so a re-render preserves the message instead of
	// destroying it. .inline-msg has no CSS rule, so the colour is set inline (as
	// at the sign-in error), and an absent message adds no empty node.
	if (flash.message) {
		const msgEl = el("p", { className: "inline-msg" }, flash.message.text);
		if (flash.message.isError) msgEl.style.color = "#e53e3e";
		popup.appendChild(msgEl);
	}

	root.appendChild(popup);
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			popup.classList.remove("popup-content--entering");
		});
	});
}

async function maybeStartPendingMeet(data: PopupData): Promise<boolean> {
	const result = await chrome.storage.local.get(PENDING_MEET_START_KEY);
	const pending = result[PENDING_MEET_START_KEY] as PendingMeetStart | undefined;
	if (!pending) return false;

	await chrome.storage.local.remove(PENDING_MEET_START_KEY);

	if (
		typeof pending.createdAt !== "number" ||
		Date.now() - pending.createdAt > PENDING_MEET_START_TTL_MS
	) {
		return false;
	}

	const tabId = pending.tabId ?? data.activeTabId;
	const meetingId = pending.meetingId ?? data.meetingId;
	if (tabId === undefined || !meetingId) return false;

	const resp = await sendMsgAwait({ type: "START_MEET", meetingId, tabId });
	if (resp.ok === true) {
		window.close();
		return true;
	}
	return false;
}

// ── Meeting flow: 4 clicks → 2 ───────────────────────────────────────────
//
// Toolbar icon click → recorder tab opens → one "Start" click → picker →
// recording starts. Previously the popup itself was a required click (pick
// "Record full-screen meeting" from the panel) before the recorder tab even
// opened. When the popup opens directly onto an idle, signed-in Meet tab,
// skip straight to the same START_INSTRUCTION the "Record full-screen
// meeting" button sends and close — the recorder tab's own mic control /
// "Record Meet tab only" affordance (recorder-page.ts) now covers what
// the skipped popup screen used to offer.
//
// Only called once, from init() below (a popup document is fresh every time
// it opens, so there is no separate re-entrancy flag to maintain) — and only
// when `data.state.kind === "idle"`, which also rules out firing over an
// arming/recording/uploading/... state.
async function maybeAutoStartMeeting(data: PopupData): Promise<boolean> {
	if (data.state.kind !== "idle") return false;
	if (data.settings.apiKey.length === 0) return false;
	if (!data.isMeetTab || !data.meetingId || data.activeTabId === undefined) {
		return false;
	}

	const resp = await sendMsgAwait({
		type: "START_INSTRUCTION",
		sourceTabId: data.activeTabId,
		meeting: true,
		meetingId: data.meetingId,
	});
	if (resp.ok === true) {
		window.close();
		return true;
	}
	// Failed (race: a recording started elsewhere between GET_STATE and here,
	// or the recorder tab couldn't open) — fall through to the ordinary panel
	// instead of leaving the popup blank.
	return false;
}

async function getSettingsFromSW(): Promise<ExtensionSettings> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(
			{ type: "GET_ALL_SETTINGS" },
			(response: unknown) => {
				if (
					chrome.runtime.lastError ||
					!response ||
					typeof response !== "object"
				) {
					resolve({
						apiBaseUrl: DEFAULT_API_BASE_URL,
						apiKey: "",
						autoRecordOnMeet: false,
						autoRecordCountdownSec: 5,
						micDeviceId: "",
						micEnabled: true,
						captureMode: "picker",
						soundEnabled: true,
						cameraOverlay: false,
						cameraDeviceId: "",
					});
					return;
				}
				resolve(response as ExtensionSettings);
			},
		);
	});
}

async function getStateFromSW(): Promise<ExtensionState> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage({ type: "GET_STATE" }, (response: unknown) => {
			if (
				chrome.runtime.lastError ||
				!response ||
				typeof response !== "object"
			) {
				resolve({ kind: "idle" });
				return;
			}
			resolve(response as ExtensionState);
		});
	});
}

function renderOnboarding(root: HTMLElement, onDone: () => void): void {
	const wrap = el("div", { className: "onboarding" });

	const logo = document.createElement("img");
	logo.src = "icons/icon-128.png";
	logo.width = 48;
	logo.height = 48;
	logo.alt = "data365";

	const heading = el("h1", {}, "Welcome to data365");

	const list = el(
		"ul",
		{ className: "onboarding-list" },
		el("li", {}, "data365 records what you choose — screen, window, or tab"),
		el(
			"li",
			{},
			"We never start recording without showing a visible countdown",
		),
		el("li", {}, "Auto-record on Google Meet is off by default"),
	);

	const gotItBtn = el("button", { className: "btn btn-primary" }, "Got it");
	gotItBtn.addEventListener("click", () => {
		chrome.storage.local.set({ capExtFirstRun: false }, () => {
			onDone();
		});
	});

	wrap.appendChild(logo);
	wrap.appendChild(heading);
	wrap.appendChild(list);
	wrap.appendChild(gotItBtn);
	root.appendChild(wrap);
}

async function init(): Promise<void> {
	const [tabs, state, settings] = await Promise.all([
		chrome.tabs.query({ active: true, currentWindow: true }),
		getStateFromSW(),
		getSettingsFromSW(),
	]);

	const activeTab = tabs[0];
	const tabUrl = activeTab?.url ?? "";
	const meetingId = getMeetingId(tabUrl);
	const isMeetTab = meetingId !== null;

	const data: PopupData = {
		state,
		settings,
		isMeetTab,
		meetingId,
		activeTabId: activeTab?.id,
	};
	currentData = data;

	const root = document.getElementById("root");
	if (!root) return;

	if (await maybeStartPendingMeet(data)) return;

	const firstRunResult = await chrome.storage.local.get("capExtFirstRun");
	const firstRunDone = firstRunResult.capExtFirstRun === false;
	// One-click meeting flow: fires only past first-run (a brand-new user still
	// sees onboarding first) — see maybeAutoStartMeeting for the idle/signed-in/
	// Meet-tab gates. On success the popup has already closed itself.
	if (firstRunDone && (await maybeAutoStartMeeting(data))) return;

	if (!firstRunDone) {
		renderOnboarding(root, () => {
			while (root.firstChild) root.removeChild(root.firstChild);
			// currentData, not `data`: a STATE_CHANGED may have arrived while the
			// onboarding screen was up, and applyState keeps currentData current.
			render(currentData ?? data);
		});
	} else {
		render(data);
	}

	chrome.runtime.onMessage.addListener((message: unknown) => {
		if (
			typeof message === "object" &&
			message !== null &&
			(message as Record<string, unknown>).type === "STATE_CHANGED"
		) {
			applyState(
				(message as Record<string, unknown>).state as ExtensionState,
			);
		}
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.capExtState?.newValue) {
			applyState(changes.capExtState.newValue as ExtensionState);
		}
	});
}

window.addEventListener("beforeunload", () => {
	stopTimer();
	teardownMic();
});

init().catch(() => {});
