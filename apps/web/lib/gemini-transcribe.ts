import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFfmpegPath } from "./audio-extract";

export interface GeminiTranscribeResult {
	transcriptVtt: string;
	inputTokens: number;
	outputTokens: number;
	words?: Array<{
		word: string;
		start: number;
		end: number;
		language?: string;
	}>;
}

interface GeminiFileResponse {
	file: {
		name: string;
		uri: string;
		state: string;
	};
}

// Long audio cannot be transcribed in a single Gemini request — the model
// stops early (finishReason=STOP) and returns only a small fraction. Splitting
// into short segments makes each segment transcribe fully (like a short clip),
// and also keeps each Gemini upload small (~13 MB) instead of one 130 MB+ blob.
// Matches v2's fast path: small 3-minute chunks (never hit MAX_TOKENS
// truncation) processed in a parallel pool of 3 (stays under Gemini RPM
// limits). This is dramatically faster than large sequential chunks.
const CHUNK_SEC = 180; // 3-minute chunks
const CHUNK_CONCURRENCY = 3; // parallel Gemini calls
// Stable model with "thinking" disabled (the 3-flash preview spends its output
// budget on hidden thinking tokens, truncating the transcript).
const TRANSCRIBE_MODEL = "gemini-2.5-flash";
const MAX_OUTPUT_TOKENS = 16384; // ample for a 3-min chunk; smaller = faster

// System instruction for the transcription agent. The user-authored rules below
// govern language, cleaning, speaker labeling, and foreign-word handling; the
// OUTPUT FORMAT section pins the representation to WebVTT because the whole app
// (transcript panel, captions, RAG chunking, AI-summary parser) reads VTT. The
// speaker scheme (unlabeled primary; "Savol:" / "Ishtirokchi:" for others) maps
// directly onto cue text, and foreign-word bolding uses **markdown** which the
// panel renders as bold.
const TRANSCRIBE_PROMPT = `Transcription Task: Uzbek Language

Task: Transcribe the provided audio file into the Uzbek language (Latin script). This transcription must be highly accurate, following specific formatting rules for foreign words and speaker identification regardless of the subject matter.

1. Script and Language
Main Language: All Uzbek words must be written in the Latin alphabet. Do not use Cyrillic for Uzbek words.
Clean Verbatim: Remove filler words (e.g., "eee", "mmm", "haligi"), stutters, and false starts. The final text should be professional and readable while remaining faithful to the original meaning.

2. Output Format (WebVTT) — REQUIRED
Output the transcript as a WebVTT file. Start the response with a "WEBVTT" header line, then one blank line, then the cues. Do not use tables, numbered lists, markdown headings, or any commentary.
Represent each speaker turn as its own cue. If one person speaks for a long stretch, split into a new cue at least every 2 minutes.
Each cue is two lines: a timestamp range line "HH:MM:SS.mmm --> HH:MM:SS.mmm" (real timestamps taken from the audio — never sample, fake, guessed, or template values), followed by the spoken text line.
Example:

WEBVTT

00:00:00.000 --> 00:00:07.500
Assalomu alaykum, bugun biz **growth hacking** haqida gaplashamiz.

00:00:07.500 --> 00:00:12.000
Savol: Bu usul kichik bizneslar uchun ham ishlaydimi?

3. Speaker Identification
Primary Speaker: Identify the main voice (e.g., lecturer, interviewer, or host). Do NOT use a label or prefix for this person's speech — begin the cue text directly with their words.
Secondary Speakers: When anyone else speaks (e.g., a student, an interviewee, or an audience member), begin that cue's text with "Savol:" or "Ishtirokchi:" depending on the context (a question vs. other participation). Keep this consistent across the whole transcript.

4. Foreign Language Handling (Crucial)
The speakers may use terms from other languages (Russian, English, etc.). You must:
Maintain Original Script: Write Russian words in the Cyrillic alphabet and English/other Latin-based languages in their original Latin spelling.
Formatting: Every single foreign word or phrase must be wrapped in **double asterisks** (bold).
No Transliteration: Do not write Russian words in Uzbek Latin (e.g., write **конечно**, not "konechno").
Universal Application: This applies to all terminology — technical, medical, legal, or slang.
Example (Russian): ...ushbu holatda **сразу** javob berish **обязательно** hisoblanadi.
Example (English): Biznesingizda **growth hacking** usullarini va **customer acquisition cost** ko'rsatkichlarini tekshiring.

5. Contextual Accuracy
If a word is muffled or unclear, use the surrounding context (the topic of discussion) to determine the most logical word. If it is impossible to identify, write [noaniq].
Ensure that technical jargon specific to the topic is spelled correctly according to its professional usage.

6. Completeness
Transcribe the ENTIRE audio file from the first second to the last.
Do not summarize, skip sections, or stop before the file ends. If the audio is long, provide the full text in its entirety.`;

function detectMimeType(audioUrl: string): string {
	const url = audioUrl.split("?")[0] ?? audioUrl;
	if (url.endsWith(".mp4") || url.endsWith(".m4a")) return "audio/mp4";
	if (url.endsWith(".wav")) return "audio/wav";
	if (url.endsWith(".ogg")) return "audio/ogg";
	if (url.endsWith(".webm")) return "audio/webm";
	return "audio/mpeg";
}

function formatVttTimestamp(seconds: number): string {
	const safe = Math.max(0, seconds);
	const h = Math.floor(safe / 3600);
	const m = Math.floor((safe % 3600) / 60);
	const s = Math.floor(safe % 60);
	const ms = Math.round((safe % 1) * 1000);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function plainTextToWebVTT(text: string, durationSec: number): string {
	const sentences = text
		.split(/(?<=[.?!])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);

	if (sentences.length === 0) return "WEBVTT\n\n";

	const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
	let vtt = "WEBVTT\n\n";
	let elapsed = 0;
	let index = 1;

	for (const sentence of sentences) {
		const fraction =
			totalChars > 0 ? sentence.length / totalChars : 1 / sentences.length;
		const cueDuration = durationSec * fraction;
		const start = formatVttTimestamp(elapsed);
		const end = formatVttTimestamp(elapsed + cueDuration);
		vtt += `${index}\n${start} --> ${end}\n${sentence}\n\n`;
		elapsed += cueDuration;
		index++;
	}

	return vtt;
}

async function pollUntilActive(
	fileName: string,
	apiKey: string,
): Promise<void> {
	const maxAttempts = 60;
	for (let i = 0; i < maxAttempts; i++) {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
		);
		if (!res.ok) {
			throw new Error(`Gemini file poll failed: ${res.status}`);
		}
		const data = (await res.json()) as { state: string };
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED") {
			throw new Error("Gemini file processing failed");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error("Gemini file never reached ACTIVE state");
}

// Upload one audio blob to the Gemini Files API and transcribe it in a single
// generateContent call. Returns the raw model text plus usage/finish metadata.
async function runGeminiTranscription(
	audioBytes: Uint8Array,
	mimeType: string,
	apiKey: string,
	temperature = 0.1,
): Promise<{
	rawText: string;
	inputTokens: number;
	outputTokens: number;
	finishReason: string;
}> {
	const displayName = `cap-audio-${Date.now()}-${randomUUID().slice(0, 8)}`;

	const initRes = await fetch(
		`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
		{
			method: "POST",
			headers: {
				"X-Goog-Upload-Protocol": "resumable",
				"X-Goog-Upload-Command": "start",
				"X-Goog-Upload-Header-Content-Length": String(audioBytes.byteLength),
				"X-Goog-Upload-Header-Content-Type": mimeType,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ file: { display_name: displayName } }),
		},
	);

	if (!initRes.ok) {
		throw new Error(`Gemini upload init failed: ${initRes.status}`);
	}

	const uploadUrl = initRes.headers.get("x-goog-upload-url");
	if (!uploadUrl) {
		throw new Error("No upload URL from Gemini Files API");
	}

	const uploadRes = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			"X-Goog-Upload-Offset": "0",
			"X-Goog-Upload-Command": "upload, finalize",
			"Content-Length": String(audioBytes.byteLength),
		},
		body: audioBytes,
	});

	if (!uploadRes.ok) {
		throw new Error(`Gemini audio upload failed: ${uploadRes.status}`);
	}

	const fileData = (await uploadRes.json()) as GeminiFileResponse;
	const { name: fileName, uri: fileUri, state } = fileData.file;

	if (!fileUri || !fileName) {
		throw new Error(
			`Gemini upload response missing file info: ${JSON.stringify(fileData)}`,
		);
	}

	if (state !== "ACTIVE") {
		await pollUntilActive(fileName, apiKey);
	}

	const genRes = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${TRANSCRIBE_MODEL}:generateContent?key=${apiKey}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				// The transcription rules live in the system instruction so they act
				// as the agent's role, per product requirement.
				systemInstruction: {
					parts: [{ text: TRANSCRIBE_PROMPT }],
				},
				contents: [
					{
						parts: [
							{ fileData: { mimeType, fileUri } },
							{
								text: "Transcribe this audio into a WebVTT transcript following the system instructions exactly.",
							},
						],
					},
				],
				generationConfig: {
					temperature,
					maxOutputTokens: MAX_OUTPUT_TOKENS,
					// Disable "thinking" — transcription needs no reasoning, and
					// thinking tokens otherwise consume the whole output budget and
					// truncate the transcript.
					thinkingConfig: { thinkingBudget: 0 },
				},
			}),
		},
	);

	const genData = (await genRes.json()) as {
		candidates?: Array<{
			content: { parts: Array<{ text?: string }> };
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
		};
		error?: { message: string };
	};

	// Best-effort cleanup of the uploaded file.
	fetch(
		`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
		{ method: "DELETE" },
	).catch(() => {});

	if (!genRes.ok) {
		throw new Error(
			`Gemini generateContent failed: ${genData.error?.message ?? genRes.status}`,
		);
	}

	return {
		rawText: genData.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
		inputTokens: genData.usageMetadata?.promptTokenCount ?? 0,
		outputTokens: genData.usageMetadata?.candidatesTokenCount ?? 0,
		finishReason: genData.candidates?.[0]?.finishReason ?? "UNKNOWN",
	};
}

function runFfmpeg(args: string[]): Promise<void> {
	const ffmpeg = getFfmpegPath();
	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", (err) =>
			reject(new Error(`ffmpeg error: ${err.message}`)),
		);
		proc.on("close", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`)),
		);
	});
}

// Probe the true duration (seconds) of an audio file straight from its bytes,
// by parsing the "Duration: HH:MM:SS.mm" line ffmpeg prints to stderr. This is
// authoritative: it does NOT trust the DB `video.duration`, which can be null or
// stale at transcription time — the bug that made a 1-hour upload transcribe only
// ~5 minutes (a null duration fell back to a 300s default, so chunking stopped
// after ~6 min). `ffmpeg -i <file>` with no output exits non-zero but still emits
// the Duration line, so we parse stderr regardless of exit code.
function probeDurationSec(filePath: string): Promise<number | null> {
	const ffmpeg = getFfmpegPath();
	return new Promise((resolve) => {
		const proc = spawn(ffmpeg, ["-i", filePath], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", () => resolve(null));
		proc.on("close", () => {
			const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
			if (!m) return resolve(null);
			const sec =
				Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
			resolve(Number.isFinite(sec) && sec > 0 ? sec : null);
		});
	});
}

// Split the full audio (already written to inputPath) into CHUNK_SEC-long mp3
// segments using ffmpeg. `totalSec` is the authoritative probed duration, so the
// loop covers the ENTIRE audio — not a stale/short DB value.
async function splitAudioFile(
	inputPath: string,
	totalSec: number,
): Promise<Array<{ bytes: Uint8Array; startSec: number }>> {
	const chunks: Array<{ bytes: Uint8Array; startSec: number }> = [];
	for (let start = 0; start < totalSec; start += CHUNK_SEC) {
		const outPath = join(tmpdir(), `chunk-${randomUUID()}.mp3`);
		await runFfmpeg([
			"-ss",
			String(start),
			"-t",
			String(CHUNK_SEC),
			"-i",
			inputPath,
			"-vn",
			"-acodec",
			"libmp3lame",
			"-b:a",
			"128k",
			"-f",
			"mp3",
			"-y",
			outPath,
		]);
		try {
			const buf = await fs.readFile(outPath);
			if (buf.length > 0) {
				chunks.push({ bytes: new Uint8Array(buf), startSec: start });
			}
		} finally {
			await fs.unlink(outPath).catch(() => {});
		}
	}

	return chunks;
}

function stripVttHeader(vtt: string): string {
	return vtt.replace(/^﻿?\s*WEBVTT[^\n]*\n?/, "").trim();
}

function msFrac(ms: string): number {
	const n = Number((ms || "0").slice(0, 3).padEnd(3, "0"));
	return Number.isNaN(n) ? 0 : n / 1000;
}

// Tolerant VTT timestamp parser. Gemini is inconsistent for short chunks and
// emits ALL of these: "HH:MM:SS.mmm", "MM:SS.mmm", single-digit "M:SS.mmm", and
// the malformed "MM:SS:mmm" / "HH:MM:SS:mmm" where a colon is used instead of a
// decimal before the milliseconds (e.g. "01:04:655" = 1m 4.655s). Returns the
// total seconds, or null if unparseable.
function parseVttSeconds(ts: string): number | null {
	const t = ts.trim().replace(",", ".");
	let main = t;
	let msPart = "0";
	const dot = t.indexOf(".");
	if (dot >= 0) {
		main = t.slice(0, dot);
		msPart = t.slice(dot + 1);
	}
	const parts = main.split(":").map((p) => p.trim());
	// No decimal ms, but a trailing 3-digit (or > 59) group means a colon was
	// mistakenly used as the ms separator — that group is milliseconds.
	if (dot < 0 && parts.length >= 3) {
		const last = parts[parts.length - 1] ?? "";
		if (last.length === 3 || Number(last) > 59) {
			msPart = last;
			parts.pop();
		}
	}
	if (parts.length === 1) {
		const only = Number(parts[0]);
		return Number.isNaN(only) ? null : only + msFrac(msPart);
	}
	if (parts.length < 2 || parts.length > 3) return null;
	const h = parts.length === 3 ? Number(parts[0]) : 0;
	const m = Number(parts[parts.length - 2]);
	const s = Number(parts[parts.length - 1]);
	if ([h, m, s].some((x) => Number.isNaN(x))) return null;
	return h * 3600 + m * 60 + s + msFrac(msPart);
}

function shiftVttTime(ts: string, offsetSec: number): string {
	const seconds = parseVttSeconds(ts);
	if (seconds === null) return ts.trim();
	return formatVttTimestamp(seconds + offsetSec);
}

// Shift every cue timestamp in a chunk's VTT by its global start offset.
function offsetVtt(vtt: string, offsetSec: number): string {
	if (offsetSec === 0) return vtt;
	return vtt
		.split("\n")
		.map((line) => {
			if (!line.includes("-->")) return line;
			const [left, right = ""] = line.split("-->");
			const rightStart = right.trim().split(/\s+/)[0] ?? "";
			return `${shiftVttTime(left ?? "", offsetSec)} --> ${shiftVttTime(rightStart, offsetSec)}`;
		})
		.join("\n");
}

// Concatenate chunk cue-bodies into one VTT with sequential cue numbers.
function mergeVttBodies(bodies: string[]): string {
	const blocks: string[] = [];
	let n = 1;
	for (const body of bodies) {
		const cueBlocks = body
			.split(/\n\s*\n/)
			.map((b) => b.trim())
			.filter(Boolean);
		for (const block of cueBlocks) {
			const lines = block.split("\n");
			// Drop a leading pure-number identifier line so we can renumber.
			if (lines[0] && /^\d+$/.test(lines[0].trim())) lines.shift();
			if (lines.length === 0) continue;
			blocks.push(`${n++}\n${lines.join("\n")}`);
		}
	}
	return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

function toVtt(rawText: string, durationSec: number): string {
	const trimmed = rawText.trimStart();
	return trimmed.startsWith("WEBVTT")
		? trimmed
		: plainTextToWebVTT(rawText, durationSec);
}

// Detect a repetition-loop response: a short token dominating the cue texts
// (e.g. "33." repeated 147× when the model looped instead of transcribing).
function isDegenerateRaw(rawText: string): boolean {
	const cues = stripVttHeader(toVtt(rawText, CHUNK_SEC))
		.split(/\n\s*\n/)
		.map((b) =>
			b
				.split("\n")
				.filter((l) => !l.includes("-->") && !/^\d+$/.test(l.trim()))
				.join(" ")
				.trim(),
		)
		.filter(Boolean);
	if (cues.length < 5) return false;
	const counts = new Map<string, number>();
	for (const c of cues) {
		const norm = normCueText(c);
		counts.set(norm, (counts.get(norm) ?? 0) + 1);
	}
	let max = 0;
	let maxNorm = "";
	for (const [k, v] of counts) {
		if (v > max) {
			max = v;
			maxNorm = k;
		}
	}
	return maxNorm.length <= 12 && max / cues.length >= 0.5;
}

// Normalize cue text for repetition comparison (strip voice tags, bold markers,
// punctuation and case).
function normCueText(t: string): string {
	return t
		.replace(/<\/?v\b[^>]*>/gi, "")
		.replace(/\*\*/g, "")
		.replace(/[.,!?;:’'"()\s]+/g, " ")
		.trim()
		.toLowerCase();
}

// Rewrite a cue's "start --> end" line into canonical HH:MM:SS.mmm on both ends,
// repairing malformed separators / short fields. Left unchanged if unparseable.
function normalizeTsLine(tsLine: string): string {
	const [left, right = ""] = tsLine.split("-->");
	const leftTs = (left ?? "").trim().split(/\s+/)[0] ?? "";
	const rightTs = right.trim().split(/\s+/)[0] ?? "";
	const l = parseVttSeconds(leftTs);
	const r = parseVttSeconds(rightTs);
	if (l === null || r === null) return tsLine.trim();
	return `${formatVttTimestamp(l)} --> ${formatVttTimestamp(r)}`;
}

// Remove Gemini repetition-loop spam (e.g. the same "33." emitted across dozens
// of cues on an unclear/silent stretch). Drops a cue when its text repeats the
// immediately-preceding cue, and caps how many times any short degenerate token
// may appear across the whole transcript. Preserves the first occurrence and its
// timestamp so real (rare) short lines still show once. Also normalizes each
// cue's timestamp line to canonical HH:MM:SS.mmm.
function collapseRepeatedCues(vtt: string): string {
	const body = stripVttHeader(vtt);
	const blocks = body
		.split(/\n\s*\n/)
		.map((b) => b.trim())
		.filter(Boolean);
	const out: string[] = [];
	const counts = new Map<string, number>();
	let prev = "";
	let n = 1;
	for (const block of blocks) {
		const lines = block.split("\n");
		if (lines[0] && /^\d+$/.test(lines[0].trim())) lines.shift();
		const tsLine = lines.find((l) => l.includes("-->"));
		if (!tsLine) continue;
		const text = lines
			.filter((l) => !l.includes("-->"))
			.join(" ")
			.trim();
		const norm = normCueText(text);
		if (norm) {
			// Drop an exact repeat of the previous cue.
			if (norm === prev) continue;
			// Cap short degenerate tokens (<= 8 chars) to 3 total appearances.
			if (norm.length <= 8) {
				const c = (counts.get(norm) ?? 0) + 1;
				counts.set(norm, c);
				if (c > 3) {
					prev = norm;
					continue;
				}
			}
		}
		prev = norm;
		out.push(`${n++}\n${normalizeTsLine(tsLine)}\n${text}`);
	}
	return `WEBVTT\n\n${out.join("\n\n")}\n`;
}

export async function transcribeWithGemini(
	audioUrl: string,
	options: {
		apiKey: string;
		audioDurationSec?: number;
		onProgress?: (done: number, total: number) => void | Promise<void>;
	},
): Promise<GeminiTranscribeResult> {
	const { apiKey, audioDurationSec = 300, onProgress } = options;

	// Download the (potentially large) audio with retry — a transient
	// "fetch failed" on a 100+ MB transfer shouldn't kill the whole job.
	let audioBytes: Uint8Array | null = null;
	let downloadErr: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const audioResponse = await fetch(audioUrl);
			if (!audioResponse.ok) {
				throw new Error(
					`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
				);
			}
			audioBytes = new Uint8Array(await audioResponse.arrayBuffer());
			break;
		} catch (err) {
			downloadErr = err;
			console.error(
				`[gemini-transcribe] audio download attempt ${attempt}/3 failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			if (attempt < 3) {
				await new Promise((res) => setTimeout(res, 3000 * attempt));
			}
		}
	}
	if (!audioBytes) {
		throw downloadErr instanceof Error
			? downloadErr
			: new Error("Audio download failed");
	}

	const mimeType = detectMimeType(audioUrl);

	// Probe the REAL duration straight from the audio bytes. The `audioDurationSec`
	// passed in comes from the DB `video.duration`, which can be null/stale at
	// transcription time; trusting it (and the 300s default) is what made a 1-hour
	// upload stop after ~5 minutes. The probe is authoritative; we only fall back
	// to the passed value if ffmpeg can't read a duration.
	const inputPath = join(tmpdir(), `src-${randomUUID()}.audio`);
	await fs.writeFile(inputPath, audioBytes);
	const probedSec = await probeDurationSec(inputPath);
	const effectiveDuration = probedSec ?? (audioDurationSec > 0 ? audioDurationSec : 0);
	console.log(
		`[gemini-transcribe] duration passed=${audioDurationSec} probed=${probedSec} -> effective=${Math.round(effectiveDuration)}s`,
	);

	// Short audio: single request (the model transcribes it fully).
	if (!effectiveDuration || effectiveDuration <= CHUNK_SEC) {
		await fs.unlink(inputPath).catch(() => {});
		const r = await runGeminiTranscription(audioBytes, mimeType, apiKey);
		console.log(
			`[gemini-transcribe] single finishReason=${r.finishReason} in=${r.inputTokens} out=${r.outputTokens} chars=${r.rawText.length}`,
		);
		await onProgress?.(1, 1);
		return {
			transcriptVtt: collapseRepeatedCues(
				toVtt(r.rawText, effectiveDuration || 300),
			),
			inputTokens: r.inputTokens,
			outputTokens: r.outputTokens,
		};
	}

	// Long audio: split into segments from the probed length, transcribe each,
	// merge with offsets.
	let chunks: Array<{ bytes: Uint8Array; startSec: number }>;
	try {
		chunks = await splitAudioFile(inputPath, effectiveDuration);
	} finally {
		await fs.unlink(inputPath).catch(() => {});
	}
	console.log(
		`[gemini-transcribe] long audio ${Math.round(effectiveDuration)}s -> ${chunks.length} chunks of ${CHUNK_SEC}s`,
	);

	let inputTokens = 0;
	let outputTokens = 0;
	let successCount = 0;
	let processed = 0;

	// Transcribe one chunk with retry. A single transient "fetch failed" / rate
	// limit shouldn't discard the segment; a permanently-failed one degrades to
	// a small placeholder so the rest of the transcript survives.
	const MAX_CHUNK_ATTEMPTS = 5;
	const transcribeChunk = async (chunk: {
		bytes: Uint8Array;
		startSec: number;
	}) => {
		const chunkDuration = Math.min(
			CHUNK_SEC,
			effectiveDuration - chunk.startSec,
		);
		// Outer guard: a chunk must NEVER throw. A thrown chunk would reject the
		// batch's Promise.all and abort the entire loop mid-way (stopping
		// transcription after N chunks). On any unexpected error we fall through to
		// a placeholder so the remaining chunks still run.
		try {
			let r: Awaited<ReturnType<typeof runGeminiTranscription>> | null = null;
			for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
				try {
					// Bump the temperature on retries to break a repetition loop (the
					// deterministic low-temp call would otherwise re-loop identically).
					const temp = attempt === 1 ? 0.1 : 0.6;
					const candidate = await runGeminiTranscription(
						chunk.bytes,
						"audio/mpeg",
						apiKey,
						temp,
					);
					r = candidate;
					// Accept a clean result; keep a degenerate one only as a last resort
					// (collapseRepeatedCues will strip its spam).
					if (
						!isDegenerateRaw(candidate.rawText) ||
						attempt === MAX_CHUNK_ATTEMPTS
					)
						break;
					console.warn(
						`[gemini-transcribe] chunk@${chunk.startSec}s degenerate output (attempt ${attempt}/${MAX_CHUNK_ATTEMPTS}), retrying at higher temperature`,
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const isQuota =
						/quota|rate.?limit|429|RESOURCE_EXHAUSTED|high demand|overloaded|503|500/i.test(
							msg,
						);
					console.error(
						`[gemini-transcribe] chunk@${chunk.startSec}s attempt ${attempt}/${MAX_CHUNK_ATTEMPTS} failed${isQuota ? " (quota/rate-limit)" : ""}: ${msg}`,
					);
					if (attempt < MAX_CHUNK_ATTEMPTS) {
						// Rate/quota limits need a longer wait for the per-minute window
						// to reset — otherwise every later chunk fails in a burst and the
						// tail of a long audio comes back empty.
						const backoff = isQuota ? 20000 * attempt : 2500 * attempt;
						await new Promise((res) => setTimeout(res, backoff));
					}
				}
			}
			if (r) {
				console.log(
					`[gemini-transcribe] chunk@${chunk.startSec}s finishReason=${r.finishReason} in=${r.inputTokens} out=${r.outputTokens} chars=${r.rawText.length}`,
				);
				const chunkVtt = toVtt(r.rawText, chunkDuration);
				return {
					startSec: chunk.startSec,
					body: stripVttHeader(offsetVtt(chunkVtt, chunk.startSec)),
					ok: true,
					inputTokens: r.inputTokens,
					outputTokens: r.outputTokens,
				};
			}
		} catch (unexpected) {
			console.error(
				`[gemini-transcribe] chunk@${chunk.startSec}s unexpected error, using placeholder:`,
				unexpected,
			);
		}
		const start = formatVttTimestamp(chunk.startSec);
		const end = formatVttTimestamp(chunk.startSec + 1);
		return {
			startSec: chunk.startSec,
			body: `${start} --> ${end}\n[transkripsiya qismi olinmadi]`,
			ok: false,
			inputTokens: 0,
			outputTokens: 0,
		};
	};

	// Parallel pool: process CHUNK_CONCURRENCY chunks at a time (the big speed
	// win vs sequential). Results merged in chronological order afterwards.
	const results: Array<{ startSec: number; body: string }> = [];
	for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
		const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
		const batchResults = await Promise.all(batch.map(transcribeChunk));
		for (const br of batchResults) {
			if (br.ok) successCount++;
			inputTokens += br.inputTokens;
			outputTokens += br.outputTokens;
			results.push({ startSec: br.startSec, body: br.body });
			processed++;
		}
		await onProgress?.(processed, chunks.length);
	}

	if (successCount === 0) {
		throw new Error("All transcription chunks failed");
	}

	results.sort((a, b) => a.startSec - b.startSec);
	const bodies = results.map((r) => r.body).filter(Boolean);

	return {
		transcriptVtt: collapseRepeatedCues(mergeVttBodies(bodies)),
		inputTokens,
		outputTokens,
	};
}
