// ── Types ──────────────────────────────────────────────────────────────────────

type NudgeState =
	| "default"
	| "countdown"
	| "recording"
	| "finishing"
	| "complete"
	| "error"
	| "hidden";

interface Settings {
	autoRecord: boolean;
	autoRecordCountdownSec: number;
	soundEnabled: boolean;
}

interface StateChangedMessage {
	type: "STATE_CHANGED";
	state: {
		kind: string;
		shareUrl?: string;
		reason?: string;
		recoverable?: boolean;
		uploadedBytes?: number;
		totalBytes?: number;
		paused?: boolean;
		startedAt?: number;
	};
}

type OutboundMessage =
	| { type: "MEET_CALL_STARTED"; meetingId: string }
	| { type: "MEET_CALL_ENDED"; meetingId: string }
	| { type: "MEET_NUDGE_RECORD_NOW"; meetingId: string }
	| { type: "MEET_NUDGE_LATER" }
	| { type: "MEET_NUDGE_DISMISS" }
	| { type: "GET_SETTINGS" }
	| { type: "STOP" }
	| { type: "CANCEL" }
	| { type: "RETRY" };

// ── State ─────────────────────────────────────────────────────────────────────

let meetingId: string | null = null;
let nudgeState: NudgeState = "hidden";
let laterUntil = 0;
let dismissed = false;
let inCall = false;

const settings: Settings = {
	autoRecord: false,
	autoRecordCountdownSec: 5,
	soundEnabled: false,
};

let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownRemaining = 0;
let recordingStartTime = 0;
// Accumulated paused time (ms), mirrored from the background state, so the pill
// timer excludes paused spans (matches the recorded media) instead of counting
// wall-clock across a pause/resume.
let pillPausedAccumMs = 0;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let meetEndTimer: ReturnType<typeof setTimeout> | null = null;

let shadowHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;

const LATER_MS = 12 * 60 * 1000;
const MEET_END_DEBOUNCE_MS = 5000;

// ── Meet detection ────────────────────────────────────────────────────────────

function isMeetingUrl(): boolean {
	return /^\/[a-z]+-[a-z]+-[a-z]+/.test(location.pathname);
}

function isInMeeting(): boolean {
	return !!(
		document.querySelector('[aria-label="Leave call"]') ||
		document.querySelector('[aria-label*="Leave call"]') ||
		document.querySelector('[data-tooltip="Leave call"]') ||
		document.querySelector('[data-tooltip*="Leave call"]')
	);
}

function currentMeetingId(): string | null {
	const m = location.pathname.match(/^(\/[a-z]+-[a-z]+-[a-z]+)/);
	return m ? m[1] : null;
}

function cancelMeetEnded(): void {
	if (meetEndTimer !== null) {
		clearTimeout(meetEndTimer);
		meetEndTimer = null;
	}
}

function scheduleMeetEnded(): void {
	if (meetEndTimer !== null) return;
	const id = meetingId;
	meetEndTimer = setTimeout(() => {
		meetEndTimer = null;
		if (!inCall) return;
		if (isMeetingUrl() && isInMeeting()) return;
		inCall = false;
		if (id) sendToBackground({ type: "MEET_CALL_ENDED", meetingId: id });
		stopCountdown();
		if (elapsedTimer !== null) {
			clearInterval(elapsedTimer);
			elapsedTimer = null;
		}
		if (nudgeState !== "recording") {
			clearNudge();
			nudgeState = "hidden";
		}
	}, MEET_END_DEBOUNCE_MS);
}

// ── Sound helpers ─────────────────────────────────────────────────────────────

function sineNode(
	ctx: AudioContext,
	freq: number,
	t: number,
	startOffset: number,
	dur: number,
	vol: number,
): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.type = "sine";
	osc.frequency.setValueAtTime(freq, t + startOffset);
	gain.gain.setValueAtTime(0, t + startOffset);
	gain.gain.linearRampToValueAtTime(vol, t + startOffset + 0.008);
	gain.gain.exponentialRampToValueAtTime(0.001, t + startOffset + dur);
	osc.start(t + startOffset);
	osc.stop(t + startOffset + dur);
}

function soundDroplet(ctx: AudioContext, t: number): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.type = "sine";
	osc.frequency.setValueAtTime(1700, t);
	osc.frequency.exponentialRampToValueAtTime(360, t + 0.11);
	gain.gain.setValueAtTime(0, t);
	gain.gain.linearRampToValueAtTime(0.12, t + 0.005);
	gain.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
	osc.start(t);
	osc.stop(t + 0.28);
}

function soundChime(ctx: AudioContext, t: number): void {
	sineNode(ctx, 880, t, 0, 0.38, 0.12);
	sineNode(ctx, 1318, t, 0.16, 0.5, 0.10);
}

function playAudio(fn: (ctx: AudioContext, t: number) => void): void {
	if (!settings.soundEnabled) return;
	try {
		const ctx = new AudioContext();
		const play = () => {
			fn(ctx, ctx.currentTime);
			setTimeout(() => ctx.close().catch(() => {}), 1500);
		};
		if (ctx.state === "suspended") {
			ctx
				.resume()
				.then(play)
				.catch(() => {});
		} else {
			play();
		}
	} catch (_) {}
}

// ── Shadow DOM + CSS ──────────────────────────────────────────────────────────

const NUDGE_CSS = `
:host { all: initial; }

.cap-nudge-container {
	position: fixed;
	top: 16px;
	left: 50%;
	transform: translateX(-50%);
	z-index: 2147483647;
	font-family: system-ui, sans-serif;
	font-size: 14px;
	color: #1a1a1a;
	pointer-events: all;
	user-select: none;
}

@keyframes cap-nudge-in {
	from { opacity: 0; transform: translateY(-12px); }
	to   { opacity: 1; transform: translateY(0); }
}

@keyframes cap-nudge-out {
	from { opacity: 1; transform: translateY(0); }
	to   { opacity: 0; transform: translateY(-8px); }
}

@keyframes cap-nudge-pulse {
	0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,.65); }
	55%       { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
}

.cap-nudge-card {
	background: #ffffff;
	border-radius: 12px;
	box-shadow: 0 8px 24px rgba(0,0,0,0.18);
	padding: 16px;
	width: 320px;
	box-sizing: border-box;
	animation: cap-nudge-in .25s cubic-bezier(.2,.8,.4,1) both;
}

.cap-nudge-card.cap-nudge-leaving { animation: cap-nudge-out .2s ease-in both; }

.cap-nudge-title {
	font-weight: 700;
	font-size: 15px;
	margin: 0 0 4px 0;
	color: #111;
}

.cap-nudge-subtitle {
	font-size: 12px;
	color: #666;
	margin: 0 0 14px 0;
}

.cap-nudge-buttons {
	display: flex;
	gap: 8px;
	align-items: center;
}

.cap-nudge-btn-primary {
	background: #675FFF;
	color: #fff;
	border: none;
	border-radius: 8px;
	padding: 8px 16px;
	font-size: 13px;
	font-weight: 600;
	cursor: pointer;
	font-family: inherit;
	transition: filter .15s, transform .1s, outline .1s;
	white-space: nowrap;
}

.cap-nudge-btn-primary:hover { filter: brightness(1.1); }

.cap-nudge-btn-primary:active {
	transform: scale(0.97);
	opacity: 0.85;
}

.cap-nudge-btn-primary:focus-visible {
	outline: 2px solid #6366f1;
	outline-offset: 2px;
}

.cap-nudge-btn-secondary {
	background: #f3f4f6;
	color: #374151;
	border: none;
	border-radius: 8px;
	padding: 8px 14px;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	font-family: inherit;
	transition: background .15s, transform .1s, outline .1s;
	white-space: nowrap;
}

.cap-nudge-btn-secondary:hover { background: #e5e7eb; }

.cap-nudge-btn-secondary:active {
	transform: scale(0.97);
	opacity: 0.85;
}

.cap-nudge-btn-secondary:focus-visible {
	outline: 2px solid #6366f1;
	outline-offset: 2px;
}

.cap-nudge-btn-dismiss {
	background: transparent;
	border: none;
	color: #9ca3af;
	font-size: 12px;
	cursor: pointer;
	font-family: inherit;
	padding: 4px 8px;
	text-decoration: underline;
	white-space: nowrap;
	transition: color .15s, opacity .1s;
}

.cap-nudge-btn-dismiss:hover { color: #6b7280; }

.cap-nudge-btn-dismiss:active { opacity: 0.5; }

.cap-nudge-btn-cancel {
	display: block;
	width: 100%;
	background: #f3f4f6;
	color: #374151;
	border: none;
	border-radius: 8px;
	padding: 9px 0;
	font-size: 13px;
	font-weight: 600;
	cursor: pointer;
	font-family: inherit;
	margin-bottom: 8px;
	transition: background .15s;
}

.cap-nudge-btn-cancel:hover { background: #e5e7eb; }

.cap-nudge-no-auto {
	display: block;
	text-align: center;
	background: transparent;
	border: none;
	color: #9ca3af;
	font-size: 11px;
	cursor: pointer;
	font-family: inherit;
	text-decoration: underline;
}

.cap-nudge-no-auto:hover { color: #6b7280; }

.cap-nudge-pill {
	background: #111827;
	border-radius: 999px;
	padding: 8px 14px;
	display: inline-flex;
	align-items: center;
	gap: 10px;
	box-shadow: 0 4px 12px rgba(0,0,0,0.15);
	animation: cap-nudge-in .25s cubic-bezier(.2,.8,.4,1) both;
}

.cap-nudge-pill.cap-nudge-leaving { animation: cap-nudge-out .2s ease-in both; }

.cap-nudge-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: #ef4444;
	flex-shrink: 0;
	animation: cap-nudge-pulse 1.9s ease-out infinite;
}

.cap-nudge-elapsed {
	font-size: 13px;
	font-weight: 600;
	color: #f9fafb;
	font-variant-numeric: tabular-nums;
	min-width: 52px;
}

.cap-nudge-paused-label {
	font-size: 11px;
	color: #9ca3af;
}

.cap-nudge-btn-stop {
	background: #ef4444;
	color: #fff;
	border: none;
	border-radius: 6px;
	padding: 4px 10px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	font-family: inherit;
	transition: filter .15s, transform .1s, outline .1s;
}

.cap-nudge-btn-stop:hover { filter: brightness(1.1); }

.cap-nudge-btn-stop:active {
	transform: scale(0.97);
	opacity: 0.85;
}

.cap-nudge-btn-stop:focus-visible {
	outline: 2px solid #6366f1;
	outline-offset: 2px;
}

.cap-nudge-progress {
	font-size: 11px;
	color: #9ca3af;
	margin-left: 4px;
}

.cap-nudge-complete-card {
	background: #ffffff;
	border-radius: 12px;
	box-shadow: 0 8px 24px rgba(0,0,0,0.18);
	padding: 16px;
	width: 320px;
	box-sizing: border-box;
	animation: cap-nudge-in .25s cubic-bezier(.2,.8,.4,1) both;
}

.cap-nudge-complete-card.cap-nudge-leaving { animation: cap-nudge-out .2s ease-in both; }

.cap-nudge-complete-check {
	font-size: 28px;
	color: #38a169;
	margin: 0 0 4px 0;
}

.cap-nudge-share-url {
	font-size: 11px;
	color: #666;
	word-break: break-all;
	margin: 4px 0 10px 0;
}

.cap-nudge-btn-copy {
	background: #675FFF;
	color: #fff;
	border: none;
	border-radius: 8px;
	padding: 7px 14px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	font-family: inherit;
	transition: filter .15s, transform .1s, outline .1s;
	white-space: nowrap;
}

.cap-nudge-btn-copy:hover { filter: brightness(1.1); }

.cap-nudge-btn-copy:active {
	transform: scale(0.97);
	opacity: 0.85;
}

.cap-nudge-btn-copy:focus-visible {
	outline: 2px solid #6366f1;
	outline-offset: 2px;
}

.cap-nudge-btn-open {
	background: #f3f4f6;
	color: #374151;
	border: none;
	border-radius: 8px;
	padding: 7px 14px;
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	font-family: inherit;
	transition: background .15s;
	white-space: nowrap;
}

.cap-nudge-btn-open:hover { background: #e5e7eb; }

.cap-nudge-error-card {
	background: #ffffff;
	border-radius: 12px;
	box-shadow: 0 4px 24px rgba(0,0,0,.18), 0 1px 4px rgba(0,0,0,.08);
	padding: 16px;
	width: 320px;
	box-sizing: border-box;
	animation: cap-nudge-in .25s cubic-bezier(.2,.8,.4,1) both;
}

.cap-nudge-error-card.cap-nudge-leaving { animation: cap-nudge-out .2s ease-in both; }

.cap-nudge-error-msg {
	font-size: 12px;
	color: #e53e3e;
	margin: 4px 0 10px 0;
}
`;

function ensureShadowRoot(): ShadowRoot {
	if (shadowRoot) return shadowRoot;

	shadowHost = document.createElement("div");
	shadowHost.id = "cap-nudge-host";
	document.body.appendChild(shadowHost);

	shadowRoot = shadowHost.attachShadow({ mode: "closed" });

	const style = document.createElement("style");
	style.textContent = NUDGE_CSS;
	shadowRoot.appendChild(style);

	const container = document.createElement("div");
	container.className = "cap-nudge-container";
	container.id = "cap-nudge-container";
	shadowRoot.appendChild(container);

	return shadowRoot;
}

function getNudgeContainer(): HTMLElement | null {
	if (!shadowRoot) return null;
	return shadowRoot.getElementById("cap-nudge-container");
}

function clearNudge(onRemoved?: () => void): void {
	const container = getNudgeContainer();
	if (!container || !container.firstChild) {
		onRemoved?.();
		return;
	}
	const child = container.firstChild as HTMLElement;
	child.classList.add("cap-nudge-leaving");
	setTimeout(() => {
		child.remove();
		onRemoved?.();
	}, 190);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function makeEl<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (className) el.className = className;
	if (text) el.textContent = text;
	return el;
}

function makeBtn(className: string, text: string): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.className = className;
	btn.textContent = text;
	return btn;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ── Nudge rendering ───────────────────────────────────────────────────────────

/**
 * PROBE — can the remote participants' audio be read straight off Meet's own
 * media elements, with no chrome.tabCapture and therefore no activeTab grant?
 *
 * If YES, the in-page "Record now" click (a real user gesture) can open the
 * screen picker directly AND still record the client's voice — the owner's
 * two-step flow, without the desktopCapture API he banned and without a desktop
 * app. If NO, those remain the only two options.
 *
 * Reports in plain Uzbek, inside the nudge card, so the owner can read it off
 * a live call without opening devtools. Read-only: every captured track is
 * stopped immediately.
 */
async function probeMeetAudio(
	report: (text: string) => void,
): Promise<string> {
	try {
		const media = Array.from(
			document.querySelectorAll<HTMLMediaElement>("audio, video"),
		);
		if (media.length === 0) return "O'LCHOV: sahifada audio/video element YO'Q";

		const streams: MediaStream[] = [];
		let blocked = 0;
		for (const el of media) {
			const capturable = el as HTMLMediaElement & {
				captureStream?: () => MediaStream;
				mozCaptureStream?: () => MediaStream;
			};
			const grab = capturable.captureStream ?? capturable.mozCaptureStream;
			if (typeof grab !== "function") continue;
			try {
				const s = grab.call(capturable);
				if (s.getAudioTracks().length > 0) streams.push(s);
			} catch {
				blocked++;
			}
		}
		if (streams.length === 0) {
			return `O'LCHOV: ${media.length} element · ovozli oqim YO'Q · bloklangan ${blocked} → MUMKIN EMAS ❌`;
		}

		// The `muted` flag was not a usable signal: on a SILENT call the tracks
		// report muted even though the pipe is fine (measured with the owner
		// 2026-07-19 — "jim edi", so a 0 there refuted nothing). Measure real
		// ENERGY instead: whoever speaks during the window moves the meter.
		const ctx = new AudioContext();
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 2048;
		for (const s of streams) ctx.createMediaStreamSource(s).connect(analyser);
		const buf = new Float32Array(analyser.fftSize);

		const WINDOW_MS = 6000;
		let peak = 0;
		const started = Date.now();
		report(
			`O'LCHOV: ${streams.length} ovozli oqim topildi. ENDI 6 SONIYA GAPIRING (yoki suhbatdosh gapirsin)…`,
		);
		while (Date.now() - started < WINDOW_MS) {
			analyser.getFloatTimeDomainData(buf);
			for (const v of buf) {
				const a = Math.abs(v);
				if (a > peak) peak = a;
			}
			const left = Math.ceil((WINDOW_MS - (Date.now() - started)) / 1000);
			report(
				`O'LCHOV: gapiring… ${left}s · hozirgi eng baland: ${(peak * 100).toFixed(1)}%`,
			);
			await new Promise((r) => setTimeout(r, 250));
		}
		await ctx.close().catch(() => undefined);
		for (const s of streams) for (const t of s.getTracks()) t.stop();

		const pct = peak * 100;
		const verdict =
			pct > 1 ? "MUMKIN ✅ (ovoz oqmoqda)" : "MUMKIN EMAS ❌ (jimlik)";
		return `O'LCHOV: ${media.length} element · ovozli oqim ${streams.length} · bloklangan ${blocked} · eng baland ${pct.toFixed(1)}% → ${verdict}`;
	} catch (err) {
		return `O'LCHOV xatosi: ${err instanceof Error ? err.message : String(err)}`;
	}
}

function renderDefaultNudge(): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	const card = makeEl("div", "cap-nudge-card");

	const title = makeEl("div", "cap-nudge-title", "Record this meeting?");
	const subtitle = makeEl(
		"div",
		"cap-nudge-subtitle",
		"Make sure participants have agreed.",
	);
	const buttons = makeEl("div", "cap-nudge-buttons");

	const btnRecord = makeBtn("cap-nudge-btn-primary", "Record now");
	const btnLater = makeBtn("cap-nudge-btn-secondary", "Later");
	const btnDismiss = makeBtn("cap-nudge-btn-dismiss", "Dismiss");

	buttons.append(btnRecord, btnLater, btnDismiss);
	card.append(title, subtitle, buttons);
	container.appendChild(card);
	nudgeState = "default";

	// FIX A (Codex v4): this button no longer captures directly — an in-page
	// gesture can't grant activeTab/tabCapture, so a direct getDisplayMedia()
	// here had NO client-audio guarantee. Only a real click on the extension
	// icon does, so this just points the user there (openPopup is attempted as
	// a convenience only, never as the guarantee).
	btnRecord.addEventListener("click", (event) => {
		event.stopImmediatePropagation();
		// PROBE (2026-07-19). The owner wants "Record now -> screen picker", two
		// steps. An in-page click IS a real user gesture, so getDisplayMedia()
		// could legally run right here — the ONLY blocker is that an in-page
		// gesture cannot grant activeTab, so chrome.tabCapture (today's source of
		// the remote voices) is unavailable on this path. The open question:
		// can Meet's remote audio be tapped straight off the page's own media
		// elements via HTMLMediaElement.captureStream(), which needs no
		// permission at all? This probe answers it with facts from a real call,
		// printed into the card so no devtools are needed. It captures nothing,
		// starts nothing, and is removed once the answer is known.
		// Deliberately NOT sending MEET_NUDGE_RECORD_NOW while the probe is in
		// place: that message flips the nudge state and tears the card down, so
		// the reading vanished before the owner could read it. The result is also
		// copied to the clipboard (allowed here — we are inside a real click) so
		// he can paste it instead of transcribing it from a disappearing card.
		void probeMeetAudio((text) => showStartNote(card, text, false)).then(
			(reading) => {
				showStartNote(
					card,
					`${reading}\n\n(nusxalandi — Ctrl+V bilan yuboring)`,
					false,
				);
				void navigator.clipboard?.writeText(reading).catch(() => undefined);
			},
		);
	});


	btnLater.addEventListener("click", () => {
		sendToBackground({ type: "MEET_NUDGE_LATER" });
		laterUntil = Date.now() + LATER_MS;
		clearNudge();
		nudgeState = "hidden";
	});

	btnDismiss.addEventListener("click", () => {
		sendToBackground({ type: "MEET_NUDGE_DISMISS" });
		dismissed = true;
		clearNudge();
		nudgeState = "hidden";
	});
}

function renderCountdownNudge(): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	countdownRemaining = settings.autoRecordCountdownSec;

	const card = makeEl("div", "cap-nudge-card");

	const titleEl = makeEl("div", "cap-nudge-title");
	const titleText = document.createTextNode("Starting recording in ");
	const numSpan = makeEl("span", undefined, String(countdownRemaining));
	const titleSuffix = document.createTextNode("s");
	titleEl.append(titleText, numSpan, titleSuffix);

	const btnCancel = makeBtn("cap-nudge-btn-cancel", "Cancel");
	const btnNoAuto = makeBtn(
		"cap-nudge-no-auto",
		"Don’t auto-record this meeting",
	);

	card.append(titleEl, btnCancel, btnNoAuto);
	container.appendChild(card);
	nudgeState = "countdown";

	const onCancel = () => {
		stopCountdown();
		sendToBackground({ type: "MEET_NUDGE_DISMISS" });
		dismissed = true;
		clearNudge();
		nudgeState = "hidden";
	};

	btnCancel.addEventListener("click", onCancel);
	btnNoAuto.addEventListener("click", onCancel);

	countdownTimer = setInterval(() => {
		countdownRemaining -= 1;
		numSpan.textContent = String(countdownRemaining);
		if (countdownRemaining <= 0) {
			stopCountdown();
			playAudio(soundChime);
			renderDefaultNudge();
			const activeCard = getNudgeContainer()?.querySelector(
				".cap-nudge-card",
			) as HTMLElement | null;
			if (activeCard) {
				showStartNote(
					activeCard,
					"Yozish uchun data365 belgisini bosing — ochilgan oynada bitta Boshlash tugmasi (mijoz ovozi kafolatli).",
					false,
				);
			}
		}
	}, 1000);
}

function stopCountdown(): void {
	if (countdownTimer !== null) {
		clearInterval(countdownTimer);
		countdownTimer = null;
	}
}

function renderRecordingPill(paused = false): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	if (recordingStartTime === 0) recordingStartTime = Date.now();

	const pill = makeEl("div", "cap-nudge-pill");
	const dot = makeEl("span", "cap-nudge-dot");
	const elapsed = makeEl(
		"span",
		"cap-nudge-elapsed",
		formatElapsed(Date.now() - recordingStartTime - pillPausedAccumMs),
	);
	elapsed.id = "cap-elapsed";
	const btnStop = makeBtn("cap-nudge-btn-stop", "Stop");

	if (paused) {
		const pausedLabel = makeEl("span", "cap-nudge-paused-label", "Paused");
		pill.append(dot, elapsed, pausedLabel, btnStop);
	} else {
		pill.append(dot, elapsed, btnStop);
	}

	container.appendChild(pill);
	nudgeState = "recording";

	if (elapsedTimer !== null) clearInterval(elapsedTimer);
	if (!paused) {
		elapsedTimer = setInterval(() => {
			const el = container.querySelector("#cap-elapsed");
			if (el)
				el.textContent = formatElapsed(
					Date.now() - recordingStartTime - pillPausedAccumMs,
				);
		}, 1000);
	}

	btnStop.addEventListener("click", () => {
		sendToBackground({ type: "STOP" });
	});
}

function renderFinishingPill(): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	if (elapsedTimer !== null) {
		clearInterval(elapsedTimer);
		elapsedTimer = null;
	}

	const pill = makeEl("div", "cap-nudge-pill");
	const dot = makeEl("span", "cap-nudge-dot");
	dot.style.background = "#3182ce";
	dot.style.animation = "none";
	const label = makeEl("span", "cap-nudge-elapsed", "Finishing up...");
	pill.append(dot, label);
	container.appendChild(pill);
	nudgeState = "finishing";
}

function renderCompletePill(shareUrl: string): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	if (elapsedTimer !== null) {
		clearInterval(elapsedTimer);
		elapsedTimer = null;
	}
	recordingStartTime = 0;

	const card = makeEl("div", "cap-nudge-complete-card");

	const check = makeEl("div", "cap-nudge-complete-check", "✓");
	const title = makeEl("div", "cap-nudge-title", "Recording saved!");
	const urlEl = makeEl("div", "cap-nudge-share-url", shareUrl);

	const buttons = makeEl("div", "cap-nudge-buttons");
	const copyBtn = makeBtn("cap-nudge-btn-copy", "Copy link");
	const openBtn = makeBtn("cap-nudge-btn-open", "Open");

	copyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(shareUrl).then(() => {
			copyBtn.textContent = "Copied!";
			setTimeout(() => {
				copyBtn.textContent = "Copy link";
			}, 2000);
		});
	});

	openBtn.addEventListener("click", () => {
		window.open(shareUrl, "_blank");
	});

	const dismissBtn = makeBtn("cap-nudge-btn-dismiss", "Dismiss");
	dismissBtn.addEventListener("click", () => {
		sendToBackground({ type: "CANCEL" } as OutboundMessage);
		clearNudge();
		nudgeState = "hidden";
	});

	buttons.append(copyBtn, openBtn);
	card.append(check, title, urlEl, buttons, dismissBtn);
	container.appendChild(card);
	nudgeState = "complete";
}

function renderErrorCard(reason: string, recoverable: boolean): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	if (elapsedTimer !== null) {
		clearInterval(elapsedTimer);
		elapsedTimer = null;
	}
	recordingStartTime = 0;

	const card = makeEl("div", "cap-nudge-error-card");
	const title = makeEl("div", "cap-nudge-title", "Upload failed");
	const msg = makeEl("div", "cap-nudge-error-msg", reason);

	const buttons = makeEl("div", "cap-nudge-buttons");

	if (recoverable) {
		const retryBtn = makeBtn("cap-nudge-btn-primary", "Retry");
		retryBtn.addEventListener("click", () => {
			sendToBackground({ type: "RETRY" } as OutboundMessage);
		});
		buttons.appendChild(retryBtn);
	}

	const dismissBtn = makeBtn("cap-nudge-btn-secondary", "Dismiss");
	dismissBtn.addEventListener("click", () => {
		sendToBackground({ type: "CANCEL" } as OutboundMessage);
		clearNudge();
		nudgeState = "hidden";
	});

	buttons.appendChild(dismissBtn);
	card.append(title, msg, buttons);
	container.appendChild(card);
	nudgeState = "error";
}

// ── Message protocol ──────────────────────────────────────────────────────────

function sendToBackground(msg: OutboundMessage): void {
	chrome.runtime.sendMessage(msg).catch(() => {});
}

function showStartNote(card: HTMLElement, text: string, isError: boolean): void {
	const existing = card.querySelector(
		".cap-nudge-send-err",
	) as HTMLElement | null;
	const note = existing ?? document.createElement("p");
	note.className = "cap-nudge-send-err";
	note.style.cssText = isError
		? "font-size:12px;color:#e53e3e;margin:6px 0 0;"
		: "font-size:12px;color:#6b7280;margin:6px 0 0;";
	note.textContent = text;
	if (!existing) card.appendChild(note);
}

// ── Main gate ─────────────────────────────────────────────────────────────────

function maybeShow(): void {
	if (!isMeetingUrl() || !isInMeeting()) {
		if (inCall) {
			scheduleMeetEnded();
		}
		return;
	}

	cancelMeetEnded();

	const id = currentMeetingId();
	if (id !== meetingId) {
		cancelMeetEnded();
		meetingId = id;
		dismissed = false;
		laterUntil = 0;
		inCall = false;
		stopCountdown();
		if (elapsedTimer !== null) {
			clearInterval(elapsedTimer);
			elapsedTimer = null;
		}
		recordingStartTime = 0;
		clearNudge();
		nudgeState = "hidden";
	}

	if (!inCall) {
		inCall = true;
		if (meetingId) sendToBackground({ type: "MEET_CALL_STARTED", meetingId });
		playAudio(soundDroplet);
	}

	if (
		nudgeState === "recording" ||
		nudgeState === "countdown" ||
		nudgeState === "finishing" ||
		nudgeState === "complete" ||
		nudgeState === "error"
	)
		return;
	if (dismissed || nudgeState === "default" || Date.now() < laterUntil) return;

	if (settings.autoRecord) {
		renderCountdownNudge();
	} else {
		renderDefaultNudge();
	}
}

// ── State change listener ─────────────────────────────────────────────────────

function handleStateChange(state: StateChangedMessage["state"]): void {
	switch (state.kind) {
		case "recording":
			stopCountdown();
			if (recordingStartTime === 0) {
				recordingStartTime = state.startedAt ?? Date.now();
			}
			pillPausedAccumMs =
				(state as { pausedAccumMs?: number }).pausedAccumMs ?? 0;
			clearNudge(() => renderRecordingPill(state.paused ?? false));
			break;
		case "uploading":
		case "finishing":
			clearNudge(() => renderFinishingPill());
			break;
		case "complete":
			if (state.shareUrl) {
				clearNudge(() => renderCompletePill(state.shareUrl as string));
			}
			break;
		case "error":
			clearNudge(() =>
				renderErrorCard(
					state.reason ?? "Unknown error",
					state.recoverable ?? false,
				),
			);
			break;
		case "idle":
			if (elapsedTimer !== null) {
				clearInterval(elapsedTimer);
				elapsedTimer = null;
			}
			recordingStartTime = 0;
			clearNudge();
			nudgeState = "hidden";
			if (isInMeeting()) {
				dismissed = false;
				setTimeout(maybeShow, 800);
			}
			break;
	}
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
	if (!msg || typeof msg !== "object") return;
	const message = msg as Record<string, unknown>;
	if (message.type === "STATE_CHANGED" && message.state) {
		handleStateChange(message.state as StateChangedMessage["state"]);
	}
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes.capExtState?.newValue) {
		handleStateChange(
			changes.capExtState.newValue as StateChangedMessage["state"],
		);
	}
});

// ── Init: fetch settings then start ──────────────────────────────────────────

chrome.runtime
	.sendMessage({ type: "GET_SETTINGS" })
	.then((resp: unknown) => {
		if (resp && typeof resp === "object") {
			const r = resp as Record<string, unknown>;
			if (typeof r.autoRecord === "boolean") settings.autoRecord = r.autoRecord;
			if (typeof r.autoRecordCountdownSec === "number")
				settings.autoRecordCountdownSec = r.autoRecordCountdownSec;
			if (typeof r.soundEnabled === "boolean")
				settings.soundEnabled = r.soundEnabled;
		}
		maybeShow();
	})
	.catch(() => {
		maybeShow();
	});

// ── SPA navigation detection ──────────────────────────────────────────────────

let lastHref = location.href;
setInterval(() => {
	if (location.href !== lastHref) {
		lastHref = location.href;
		maybeShow();
	}
}, 1000);

window.addEventListener("popstate", maybeShow);
window.addEventListener("hashchange", maybeShow);

let mutationDebounce: ReturnType<typeof setTimeout> | null = null;
const observer = new MutationObserver(() => {
	if (mutationDebounce !== null) clearTimeout(mutationDebounce);
	mutationDebounce = setTimeout(maybeShow, 500);
});
observer.observe(document.body, { childList: true, subtree: true });
