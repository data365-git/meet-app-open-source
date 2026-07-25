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

const TRANSCRIBE_PROMPT = `You are a professional Uzbek meeting transcription editor.

Transcribe the attached online/offline meeting fully and accurately in Uzbek Latin.

Rules:

1. Transcribe the entire meeting from beginning to end. Do not summarize, skip, shorten, or stop halfway.

2. Uzbek words must be written only in Uzbek Latin. Do not write Uzbek words in Cyrillic.

3. This meeting has multiple speakers. Identify speakers by voice, context, and conversation flow.

If speaker names are known from the audio, use their names.

If names are not clear, use:
Speaker 1
Speaker 2
Speaker 3

Keep speaker labels consistent across the whole transcript.

Each WEBVTT cue must contain EXACTLY ONE speaker. Begin each cue's text with a WebVTT voice tag: <v Speaker Name> followed by that speaker's words. NEVER merge two speakers into a single cue. Example of correct format:

00:00:12.500 --> 00:00:15.200
<v Bunyodbek>Salom, qanday yangiliklar bor?

00:00:15.500 --> 00:00:18.100
<v Jahongir>Yangi mijoz keldi, **deadline** ertaga.

If two people talk over each other and both cannot be clearly separated, split into two adjacent cues with the same or overlapping timestamps and add the [ustma-ust gaplashildi] tag on the second cue.

4. Add real, accurate timestamps from the audio. Do not use sample, fake, guessed, or template timestamps.

Put timestamps only where they exactly match the audio:
- at the beginning,
- when the speaker changes,
- when a new discussion topic starts,
- when decisions, tasks, objections, or important points appear,
- when there is a meaningful pause or transition.

Timestamp format:
**[HH:MM:SS]**

5. Clean the transcript professionally:
- remove filler sounds like "umm", "aa", "eee", "э"
- remove repeated stutters
- remove meaningless false starts
- keep the original meaning and speaking style

6. If an Uzbek word is unclear, correct it based on surrounding context. If it is impossible to identify, write [noaniq].

7. Keep foreign words exactly as spoken:
- Russian words must stay in Cyrillic and be bold: **сразу**, **любой**, **дефицит**
- English words must stay in English/Latin and be bold: **deadline**, **CRM**, **dashboard**
- Do not translate foreign words.
- Do not transliterate Russian words into Latin.
- Bold every foreign word or phrase.

RUSSIAN MUST BE IN CYRILLIC SCRIPT — this is mandatory, not a preference.
Write **полностью**, never **polnostyu**. Write **подробный**, never **podrobniy**.
Write **аудит**, never **audit**. Whenever you hear a Russian word, output it in
Cyrillic letters and wrap it in **bold**.

8. Identify REAL speaker names. The speakers address each other by name during
the meeting — listen for those names and use them as the voice tag, e.g.
<v Shohrux> and <v Bunyodbek>. Only fall back to <v Speaker 1> when no name is
ever spoken aloud.

9. Output only the transcript. No intro, no explanation, no table, no numbering.

IMPORTANT: Start your response with "WEBVTT" header and format each line as WebVTT cues with timestamps in HH:MM:SS.mmm --> HH:MM:SS.mmm format. The speaker labels, bold formatting, and content rules above still apply within each cue text.`;

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
				contents: [
					{
						parts: [
							{ fileData: { mimeType, fileUri } },
							{ text: TRANSCRIBE_PROMPT },
						],
					},
				],
				generationConfig: {
					temperature: 0.1,
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

// Split the full audio into CHUNK_SEC-long mp3 segments using ffmpeg.
async function splitAudioBytes(
	audioBytes: Uint8Array,
	totalSec: number,
): Promise<Array<{ bytes: Uint8Array; startSec: number }>> {
	const inputPath = join(tmpdir(), `src-${randomUUID()}.audio`);
	await fs.writeFile(inputPath, audioBytes);

	const chunks: Array<{ bytes: Uint8Array; startSec: number }> = [];
	try {
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
	} finally {
		await fs.unlink(inputPath).catch(() => {});
	}

	return chunks;
}

function stripVttHeader(vtt: string): string {
	return vtt.replace(/^﻿?\s*WEBVTT[^\n]*\n?/, "").trim();
}

function shiftVttTime(ts: string, offsetSec: number): string {
	const m = ts.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/);
	if (!m) return ts.trim();
	const seconds =
		Number(m[1]) * 3600 +
		Number(m[2]) * 60 +
		Number(m[3]) +
		Number((m[4] ?? "0").padEnd(3, "0")) / 1000 +
		offsetSec;
	return formatVttTimestamp(seconds);
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

	// Short audio: single request (the model transcribes it fully).
	if (!audioDurationSec || audioDurationSec <= CHUNK_SEC) {
		const r = await runGeminiTranscription(audioBytes, mimeType, apiKey);
		console.log(
			`[gemini-transcribe] single finishReason=${r.finishReason} in=${r.inputTokens} out=${r.outputTokens} chars=${r.rawText.length}`,
		);
		await onProgress?.(1, 1);
		return {
			transcriptVtt: toVtt(r.rawText, audioDurationSec || 300),
			inputTokens: r.inputTokens,
			outputTokens: r.outputTokens,
		};
	}

	// Long audio: split into segments, transcribe each, merge with offsets.
	const chunks = await splitAudioBytes(audioBytes, audioDurationSec);
	console.log(
		`[gemini-transcribe] long audio ${Math.round(audioDurationSec)}s -> ${chunks.length} chunks of ${CHUNK_SEC}s`,
	);

	let inputTokens = 0;
	let outputTokens = 0;
	let successCount = 0;
	let processed = 0;

	// Transcribe one chunk with retry. A single transient "fetch failed" / rate
	// limit shouldn't discard the segment; a permanently-failed one degrades to
	// a small placeholder so the rest of the transcript survives.
	const transcribeChunk = async (chunk: {
		bytes: Uint8Array;
		startSec: number;
	}) => {
		const chunkDuration = Math.min(CHUNK_SEC, audioDurationSec - chunk.startSec);
		let r: Awaited<ReturnType<typeof runGeminiTranscription>> | null = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				r = await runGeminiTranscription(chunk.bytes, "audio/mpeg", apiKey);
				break;
			} catch (err) {
				console.error(
					`[gemini-transcribe] chunk@${chunk.startSec}s attempt ${attempt}/3 failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				if (attempt < 3) {
					await new Promise((res) => setTimeout(res, 2000 * attempt));
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
		transcriptVtt: mergeVttBodies(bodies),
		inputTokens,
		outputTokens,
	};
}
