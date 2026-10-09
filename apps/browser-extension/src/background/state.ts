import { DEFAULT_API_BASE_URL } from "../shared/config";

export interface CompletedPart {
	ETag: string;
	PartNumber: number;
}

export interface ExtensionSettings {
	apiBaseUrl: string;
	apiKey: string;
	autoRecordOnMeet: boolean;
	autoRecordCountdownSec: number;
	micDeviceId: string;
	micEnabled: boolean;
	captureMode: "picker" | "silent-tab";
	soundEnabled: boolean;
	cameraOverlay: boolean;
	cameraDeviceId: string;
}

interface IdleState {
	kind: "idle";
}

interface ArmingState {
	kind: "arming";
	mode: "instruction" | "meeting";
	meetingId?: string;
	tabId?: number;
	// For an in-page Meet nudge recording, the Meet content script owns the
	// MediaStream and MediaRecorder.
	contentRecorderTabId?: number;
	// For an instruction recording, the id of the visible recorder.html tab that
	// owns the capture. Stop/pause/resume/cancel must be routed to THIS tab.
	recorderTabId?: number;
	// For an instruction recording started from a Meet/audible tab: the id of THAT
	// tab, so the recorder page can pull its audio (remote participants) via
	// tabCapture and mix it in — no "share system audio" tick needed.
	sourceTabId?: number;
	// Guaranteed-client-audio mode: the "Record full-screen meeting" popup button
	// sets this true, which becomes the ?meeting=1 param on the recorder.html tab
	// URL (see sw.ts openInstructionRecorder). From then on the guarantee lives
	// with THAT TAB, not this record — this record is volatile (INSTRUCTION_CANCEL/
	// RETRY/another recorder tab's beforeunload can clear it mid-flow), so
	// REQUEST_TAB_AUDIO and RECORDER_STARTED re-derive `required`/sourceTabId from
	// the recorder page's own message (validated by sender origin) instead of
	// reading this field back. Used only as the RECORDER_STARTED fallback when
	// that message field is absent.
	meetingRequired?: boolean;
}

interface RecordingState {
	kind: "recording";
	mode: "instruction" | "meeting";
	videoId: string;
	uploadId: string;
	startedAt: number;
	parts: CompletedPart[];
	nextPartNumber: number;
	totalBytes: number;
	uploadedBytes: number;
	meetingId?: string;
	tabId?: number;
	// For an in-page Meet nudge recording, stop/pause/resume/cancel route back
	// to the Meet tab content script instead of the offscreen tabCapture path.
	contentRecorderTabId?: number;
	// For an instruction recording, the id of the visible recorder.html tab that
	// owns the capture. Stop/pause/resume/cancel must be routed to THIS tab, and
	// if the tab closes unexpectedly the arming/recording lock must be released.
	recorderTabId?: number;
	// Carried over from ArmingState so mid-recording watchdogs (tab closed/
	// navigated away, tab-audio track lost) know which tab to watch and whether
	// a loss must fail loudly (see meetingRequired).
	sourceTabId?: number;
	meetingRequired?: boolean;
	mime: string;
	paused: boolean;
	// Timestamp when the current pause began; undefined while running. With
	// pausedAccumMs this lets the displayed timer FREEZE on pause and exclude
	// paused time after resume (the recorded media already excludes it).
	pausedAt?: number;
	// Total paused time (ms) accumulated across prior pause/resume cycles.
	pausedAccumMs?: number;
	// (F2) Identity of the RECORDER that owns this recording — minted by the
	// recorder itself at start and echoed on every RECORDER_CHUNK/STOPPED/ERROR.
	// Without it the SW appends whatever arrives to whatever upload is live, so a
	// MediaRecorder still running from an EARLIER session writes its fragments
	// into this one: that is what produced the 2026-07-23 unplayable recording
	// (two fMP4 streams interleaved in a single result.mp4). Optional only for
	// forward-compat of a state persisted by an older build; a recording that HAS
	// one strict-drops any message that does not match, including unstamped ones.
	recorderSessionId?: string;
}

interface UploadingState {
	kind: "uploading";
	videoId: string;
	uploadId: string;
	parts: CompletedPart[];
	totalBytes: number;
	uploadedBytes: number;
	// True when this upload was a MEETING (see meeting.ts isMeetingFiling) —
	// drives the auto-open of the video page on completion. Optional so a
	// persisted 0.5.9 state (which has no such field) still parses and simply
	// treats missing as false.
	isMeeting?: boolean;
}

interface FinishingState {
	kind: "finishing";
	videoId: string;
	// (R9) Enough to RESUME the finalize after a crash/restart. Without these
	// a persisted "finishing" was unrecoverable — every byte sat in R2 and the
	// user was told to re-record because we no longer knew which multipart to
	// complete. Optional so older persisted states still parse.
	uploadId?: string;
	parts?: CompletedPart[];
	// Elapsed recording seconds, computed once from the RecordingState's
	// startedAt/pausedAccumMs before that timing data goes away (neither this
	// state nor "uploading" carries it). Persisted here so a crash/restart that
	// resumes the finalize via resumeInterruptedFinishing can still send it.
	durationInSecs?: number;
	// Same flag as UploadingState.isMeeting — carried through the finalize so a
	// crash/resume (resumeInterruptedFinishing → drained "complete") still knows
	// to auto-open the video page. Optional: a persisted 0.5.9 "finishing" state
	// has no such field and is treated as false.
	isMeeting?: boolean;
}

interface CompleteState {
	kind: "complete";
	videoId: string;
	shareUrl: string;
}

interface ErrorState {
	kind: "error";
	reason: string;
	recoverable: boolean;
	previousVideoId?: string;
}

export type ExtensionState =
	| IdleState
	| ArmingState
	| RecordingState
	| UploadingState
	| FinishingState
	| CompleteState
	| ErrorState;

const STATE_KEY = "capExtState";
const SETTINGS_KEY = "capExtSettings";

const DEFAULT_SETTINGS: ExtensionSettings = {
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
};

export async function getState(): Promise<ExtensionState> {
	const result = await chrome.storage.local.get(STATE_KEY);
	return (result[STATE_KEY] as ExtensionState | undefined) ?? { kind: "idle" };
}

export async function setState(state: ExtensionState): Promise<void> {
	await chrome.storage.local.set({ [STATE_KEY]: state });
	broadcastState(state);
}

function broadcastState(state: ExtensionState): void {
	const payload = { type: "STATE_CHANGED", state };

	chrome.runtime.sendMessage(payload).catch(() => {});

	chrome.tabs
		.query({ url: "https://meet.google.com/*" })
		.then((tabs) => {
			for (const tab of tabs) {
				if (tab.id != null) {
					chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
				}
			}
		})
		.catch(() => {});
}

export async function getSettings(): Promise<ExtensionSettings> {
	const result = await chrome.storage.local.get(SETTINGS_KEY);
	const stored =
		(result[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined) ?? {};
	return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(
	settings: Partial<ExtensionSettings>,
): Promise<void> {
	const current = await getSettings();
	await chrome.storage.local.set({
		[SETTINGS_KEY]: { ...current, ...settings },
	});
}
