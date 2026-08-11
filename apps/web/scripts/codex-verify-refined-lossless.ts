import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
// Relative import: scripts may run under tsx without the "@/" alias mapping.
import { getPaidGeminiKey } from "../lib/gemini-paid-key";

const videoId = process.argv[2] ?? "151qnwcyxkarpdk";
const GEMINI_SUMMARY_MODEL = "gemini-3-flash-preview";
const MAX_FILTER_CHARS = 12_000;

interface VttSegment {
	start: number;
	text: string;
}

interface RefinedLine {
	id: number;
	start: number;
	time: string;
	text: string;
	speaker: string | null;
}

const ACK_WORDS = new Set([
	"aha",
	"aha aha",
	"mhm",
	"hm",
	"hmm",
	"mm",
	"uh",
	"um",
	"uh huh",
	"xop",
	"hop",
	"mayli",
	"ok",
	"okay",
	"okey",
	"aga",
	"ugu",
	"aga aga",
	"ugu ugu",
	"да",
	"ага",
	"угу",
	"угу угу",
]);

const ENTITY_STOPWORDS = new Set([
	"admin",
	"speaker",
	"bugun",
	"mana",
	"demak",
	"lekin",
	"keyin",
	"shunaqa",
	"ha",
	"yoq",
	"yani",
	"agar",
	"bilan",
	"uchun",
	"kerak",
	"bor",
	"yo",
	"va",
	"the",
	"and",
	"this",
	"that",
	"yes",
	"no",
	"ok",
	"okay",
]);

function formatTranscriptTime(seconds: number): string {
	const safeSeconds = Number.isFinite(seconds)
		? Math.max(0, Math.floor(seconds))
		: 0;
	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const secs = safeSeconds % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function stripWebVttTags(text: string): string {
	return text
		.replace(/<\/?(?:v|c|i|b|u|lang|ruby|rt)(?:\.[\w-]+)*(?:\s[^>]*)?>/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeWebVttLine(text: string): string {
	const raw = text.replace(/\s+/g, " ").trim();
	const voice = raw.match(/^<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/i);
	if (!voice) return stripWebVttTags(raw);
	const speaker = stripWebVttTags(voice[1] ?? "");
	const spoken = stripWebVttTags(voice[2] ?? "");
	return speaker && spoken ? `${speaker}: ${spoken}` : spoken || speaker;
}

function parseVttWithTimestamps(vttContent: string): VttSegment[] {
	const lines = vttContent.split(/\r?\n/);
	const segments: VttSegment[] = [];
	let currentStart = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.includes("-->")) {
			const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
			if (timeMatch) {
				currentStart =
					Number.parseInt(timeMatch[1] ?? "0", 10) * 3600 +
					Number.parseInt(timeMatch[2] ?? "0", 10) * 60 +
					Number.parseInt(timeMatch[3] ?? "0", 10);
			}
			continue;
		}
		if (!line || line === "WEBVTT" || /^\d+$/.test(line)) continue;
		const text = normalizeWebVttLine(line);
		if (text) segments.push({ start: currentStart, text });
	}

	return segments;
}

function splitSpeakerPrefix(text: string): {
	speaker: string | null;
	body: string;
} {
	const trimmed = text.trim();
	const match = trimmed.match(/^([^:\n]{1,50}):\s+(.+)$/);
	if (!match) return { speaker: null, body: trimmed };
	return {
		speaker: match[1]?.trim() || null,
		body: match[2]?.trim() || trimmed,
	};
}

function normalizeComparable(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`'’]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function buildLines(segments: VttSegment[]): RefinedLine[] {
	return segments
		.map((segment) => ({ start: segment.start, text: segment.text.trim() }))
		.filter((line) => line.text.length > 0)
		.map((line, id) => {
			const { speaker } = splitSpeakerPrefix(line.text);
			return {
				id,
				start: line.start,
				time: formatTranscriptTime(line.start),
				text: line.text,
				speaker,
			};
		});
}

function isPureAck(line: RefinedLine): boolean {
	return ACK_WORDS.has(normalizeComparable(splitSpeakerPrefix(line.text).body));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactRepeat(line: RefinedLine, lines: RefinedLine[]): boolean {
	const normalized = normalizeComparable(splitSpeakerPrefix(line.text).body);
	if (!normalized) return false;
	return lines.slice(Math.max(0, line.id - 3), line.id).some((prev) => {
		return (
			normalizeComparable(splitSpeakerPrefix(prev.text).body) === normalized
		);
	});
}

function isBareEcho(line: RefinedLine, lines: RefinedLine[]): boolean {
	const normalized = normalizeComparable(splitSpeakerPrefix(line.text).body);
	if (!normalized) return false;
	const tokens = normalized.split(" ");
	if (tokens.length > 3 || normalized.length > 40) return false;
	const pattern = new RegExp(`(^| )${escapeRegExp(normalized)}( |$)`);
	return lines.slice(Math.max(0, line.id - 3), line.id).some((prev) => {
		return pattern.test(
			normalizeComparable(splitSpeakerPrefix(prev.text).body),
		);
	});
}

function isShortFalseStart(line: RefinedLine): boolean {
	const { body } = splitSpeakerPrefix(line.text);
	const normalized = normalizeComparable(body);
	if (!normalized || /\d/.test(normalized)) return false;
	return (
		normalized.split(" ").length <= 5 && /(?:[-–—]|\.\.\.|…)\s*$/.test(body)
	);
}

function isSafeDelete(line: RefinedLine, lines: RefinedLine[]): boolean {
	return (
		isPureAck(line) ||
		isExactRepeat(line, lines) ||
		isBareEcho(line, lines) ||
		isShortFalseStart(line)
	);
}

function extractProtectedTokens(text: string): Set<string> {
	if (ACK_WORDS.has(normalizeComparable(splitSpeakerPrefix(text).body))) {
		return new Set();
	}

	const tokens = new Set<string>();
	for (const number of extractNumbers(text)) tokens.add(`n:${number}`);
	for (const entity of extractEntityLikeTokens(text)) tokens.add(`e:${entity}`);
	return tokens;
}

function guardDeletesForProtectedTokens(
	lines: RefinedLine[],
	deleteIds: Set<number>,
): Set<number> {
	const guardedDeleteIds = new Set(deleteIds);
	const keptTokens = new Set<string>();

	for (const line of lines) {
		if (guardedDeleteIds.has(line.id)) continue;
		for (const token of extractProtectedTokens(line.text))
			keptTokens.add(token);
	}

	for (const line of lines) {
		if (!guardedDeleteIds.has(line.id)) continue;
		const lineTokens = extractProtectedTokens(line.text);
		if ([...lineTokens].some((token) => !keptTokens.has(token))) {
			guardedDeleteIds.delete(line.id);
			for (const token of lineTokens) keptTokens.add(token);
		}
	}

	return guardedDeleteIds;
}

function parseDeleteIds(content: string, lines: RefinedLine[]): Set<number> {
	const validIds = new Set(lines.map((line) => line.id));
	const out = new Set<number>();
	const parsed = JSON.parse(
		content.replace(/```json\s*|```\s*/g, "").trim(),
	) as {
		deleteIds?: unknown[];
		lines?: Array<{
			id?: unknown;
			delete?: unknown;
			keep?: unknown;
			action?: unknown;
		}>;
	};
	const add = (id: unknown) => {
		const parsedId =
			typeof id === "number"
				? id
				: typeof id === "string" && /^\d+$/.test(id)
					? Number.parseInt(id, 10)
					: null;
		if (parsedId !== null && validIds.has(parsedId)) out.add(parsedId);
	};
	if (Array.isArray(parsed.deleteIds)) {
		for (const id of parsed.deleteIds) add(id);
	}
	if (Array.isArray(parsed.lines)) {
		for (const line of parsed.lines) {
			if (
				line.delete === true ||
				line.keep === false ||
				line.action === "delete"
			) {
				add(line.id);
			}
		}
	}
	return out;
}

function buildDeletePrompt(lines: RefinedLine[]): string {
	const transcriptLines = JSON.stringify(
		lines.map(({ id, time, speaker, text }) => ({ id, time, speaker, text })),
		null,
		2,
	);

	return `You are a lossless transcript noise classifier.

Your only job is to mark transcript lines that should be DELETED. You must not rewrite, shorten, translate, merge, or clean any text. The application will keep every unmarked line verbatim.

Delete a line ONLY when the whole line is useless noise:
- Pure acknowledgement/backchannel: "aha", "xo'p", "mhm", "uh huh", "ага", "угу", etc.
- A bare echo of a number or word the other speaker just said.
- Exact verbatim repetition of a previous line.
- A false start with no completed useful content.

KEEP every line that contains any fact, number, name, price, place, decision, explanation, argument, question, or answer. When unsure, KEEP. Do not translate Uzbek, Russian, or English.

Return ONLY valid JSON in this exact shape:
{"deleteIds":[1,2,3]}

Do not include ids for lines that should be kept.

Transcript lines:
${transcriptLines}`;
}

function buildParagraphs(
	lines: RefinedLine[],
	deleteIds: Set<number>,
): string[] {
	const paragraphs: string[] = [];
	let currentSpeaker: string | null = null;
	let currentParts: string[] = [];
	let currentLength = 0;

	const flush = () => {
		if (currentParts.length > 0) paragraphs.push(currentParts.join(" ").trim());
		currentSpeaker = null;
		currentParts = [];
		currentLength = 0;
	};

	for (const line of lines) {
		if (deleteIds.has(line.id)) continue;
		const { speaker } = splitSpeakerPrefix(line.text);
		const canJoin =
			currentParts.length > 0 &&
			speaker !== null &&
			speaker === currentSpeaker &&
			currentLength + line.text.length < 2000;
		if (!canJoin) flush();
		currentSpeaker = speaker;
		currentParts.push(line.text);
		currentLength += line.text.length + 1;
	}
	flush();
	return paragraphs;
}

function chunkSegments(segments: VttSegment[]): VttSegment[][] {
	const chunks: VttSegment[][] = [];
	let current: VttSegment[] = [];
	let chars = 0;
	for (const segment of segments) {
		const nextChars = chars + segment.text.length + 1;
		if (current.length > 0 && nextChars > MAX_FILTER_CHARS) {
			chunks.push(current);
			current = [];
			chars = 0;
		}
		current.push(segment);
		chars += segment.text.length + 1;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

async function callGeminiDeleteIds(lines: RefinedLine[]): Promise<{
	deleteIds: Set<number>;
	inputTokens: number;
	outputTokens: number;
	skipped: boolean;
}> {
	// Routed through the paid-key gate (round-7 #5): even an operator-run
	// verification script must name its use to read the paid credential.
	const apiKey = getPaidGeminiKey({ operation: "ops-script" });
	if (!apiKey) {
		return {
			deleteIds: new Set(),
			inputTokens: 0,
			outputTokens: 0,
			skipped: true,
		};
	}

	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SUMMARY_MODEL}:generateContent?key=${apiKey}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: buildDeletePrompt(lines) }] }],
				generationConfig: {
					temperature: 0.2,
					maxOutputTokens: 8192,
					responseMimeType: "application/json",
					thinkingConfig: { thinkingBudget: 0 },
				},
			}),
			signal: AbortSignal.timeout(120_000),
		},
	);
	const data = (await res.json()) as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
		};
		error?: { message?: string };
	};
	if (!res.ok) {
		throw new Error(
			`Gemini failed ${res.status}: ${data.error?.message ?? "unknown"}`,
		);
	}
	const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
	return {
		deleteIds: parseDeleteIds(content, lines),
		inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
		outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
		skipped: false,
	};
}

async function filterSegments(segments: VttSegment[]) {
	const lines = buildLines(segments);
	const deleteIds = new Set(lines.filter(isPureAck).map((line) => line.id));
	let modelSuggested = 0;
	let modelAccepted = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let skipped = false;
	let failed = false;

	try {
		const model = await callGeminiDeleteIds(lines);
		inputTokens += model.inputTokens;
		outputTokens += model.outputTokens;
		skipped = model.skipped;
		modelSuggested = model.deleteIds.size;
		for (const id of model.deleteIds) {
			const line = lines[id];
			if (line && isSafeDelete(line, lines)) {
				deleteIds.add(id);
				modelAccepted++;
			}
		}
	} catch (error) {
		failed = true;
		console.error(
			"[verify-refined] classifier chunk failed; using safe deterministic deletes",
			error,
		);
	}

	const guardedDeleteIds = guardDeletesForProtectedTokens(lines, deleteIds);

	return {
		paragraphs: buildParagraphs(lines, guardedDeleteIds),
		stats: {
			lines: lines.length,
			deterministicDeletes: lines.filter(isPureAck).length,
			modelSuggested,
			modelAccepted,
			protectedRestores: deleteIds.size - guardedDeleteIds.size,
			inputTokens,
			outputTokens,
			skipped,
			failed,
		},
	};
}

async function bodyToString(body: unknown): Promise<string> {
	if (!body) return "";
	if (
		typeof body === "object" &&
		"transformToString" in body &&
		typeof body.transformToString === "function"
	) {
		return body.transformToString();
	}
	const chunks: Buffer[] = [];
	for await (const chunk of body as AsyncIterable<
		Buffer | Uint8Array | string
	>) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function getTranscriptVtt(ownerId: string): Promise<string> {
	const bucket = process.env.CAP_AWS_BUCKET ?? process.env.CLOUDFLARE_R2_BUCKET;
	const endpoint =
		process.env.S3_PUBLIC_ENDPOINT ??
		process.env.CAP_AWS_ENDPOINT ??
		(process.env.CLOUDFLARE_R2_ACCOUNT_ID
			? `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
			: undefined);
	const accessKeyId =
		process.env.CAP_AWS_ACCESS_KEY ?? process.env.CLOUDFLARE_R2_ACCESS_KEY;
	const secretAccessKey =
		process.env.CAP_AWS_SECRET_KEY ?? process.env.CLOUDFLARE_R2_SECRET_KEY;

	if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
		throw new Error("Missing S3/R2 env needed to fetch transcription.vtt");
	}

	const client = new S3Client({
		region: process.env.CAP_AWS_REGION ?? "auto",
		endpoint,
		forcePathStyle: (process.env.S3_PATH_STYLE ?? "true") === "true",
		credentials: { accessKeyId, secretAccessKey },
	});
	const response = await client.send(
		new GetObjectCommand({
			Bucket: bucket,
			Key: `${ownerId}/${videoId}/transcription.vtt`,
		}),
	);
	return bodyToString(response.Body);
}

function extractNumbers(text: string): string[] {
	const matches = text.match(/\d[\d\s.,]*\d|\d/g) ?? [];
	return [
		...new Set(
			matches
				.map((match) => match.replace(/\D/g, ""))
				.filter((match) => match.length >= 2),
		),
	].sort((a, b) => Number(a) - Number(b));
}

function extractEntityLikeTokens(text: string): string[] {
	const matches =
		text.match(
			/\b(?:[A-Z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*|[A-Za-z]*\d+[A-Za-z]*|[А-ЯЁ][А-ЯЁа-яё0-9]+)\b/g,
		) ?? [];

	return [
		...new Set(
			matches
				.map((match) => match.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
				.filter((match) => match.length > 1)
				.filter((match) => !/^\d+$/.test(match))
				.map((match) => match.toLowerCase())
				.filter((match) => !ACK_WORDS.has(normalizeComparable(match)))
				.filter((match) => !ENTITY_STOPWORDS.has(match)),
		),
	].sort();
}

function countStandaloneAckLines(texts: string[]): number {
	return texts.filter((text) =>
		ACK_WORDS.has(normalizeComparable(splitSpeakerPrefix(text).body)),
	).length;
}

function standaloneAckSamples(texts: string[]): string[] {
	return texts
		.filter((text) =>
			ACK_WORDS.has(normalizeComparable(splitSpeakerPrefix(text).body)),
		)
		.slice(0, 10);
}

async function main() {
	console.error(`[verify-refined] loading video ${videoId}`);
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);

	if (!video) throw new Error(`Video not found: ${videoId}`);

	console.error("[verify-refined] loading transcription.vtt");
	const vtt = await getTranscriptVtt(video.ownerId);
	const segments = parseVttWithTimestamps(vtt);
	const chunks = chunkSegments(segments);
	console.error(
		`[verify-refined] filtering ${segments.length} segments in ${chunks.length} chunks`,
	);

	const paragraphs: string[] = [];
	const chunkStats = [];
	for (let i = 0; i < chunks.length; i++) {
		console.error(`[verify-refined] chunk ${i + 1}/${chunks.length}`);
		const result = await filterSegments(chunks[i] ?? []);
		paragraphs.push(...result.paragraphs);
		chunkStats.push(result.stats);
	}

	const inputTexts = segments.map((segment) => segment.text);
	const inputText = inputTexts.join("\n");
	const outputText = paragraphs.join("\n");

	const inputNumbers = extractNumbers(inputText);
	const outputNumbers = new Set(extractNumbers(outputText));
	const missingNumbers = inputNumbers.filter(
		(number) => !outputNumbers.has(number),
	);

	const inputEntities = extractEntityLikeTokens(inputText);
	const outputEntities = new Set(extractEntityLikeTokens(outputText));
	const missingEntities = inputEntities.filter(
		(entity) => !outputEntities.has(entity),
	);

	const summary = {
		videoId,
		segments: segments.length,
		chunks: chunks.length,
		inputChars: inputText.length,
		outputChars: outputText.length,
		outputReductionPct: Number(
			(
				((inputText.length - outputText.length) / inputText.length) *
				100
			).toFixed(2),
		),
		usage: {
			inputTokens: chunkStats.reduce((sum, stat) => sum + stat.inputTokens, 0),
			outputTokens: chunkStats.reduce(
				(sum, stat) => sum + stat.outputTokens,
				0,
			),
		},
		filter: {
			modelSkipped: chunkStats.every((stat) => stat.skipped),
			failedChunks: chunkStats.filter((stat) => stat.failed).length,
			deterministicDeletes: chunkStats.reduce(
				(sum, stat) => sum + stat.deterministicDeletes,
				0,
			),
			modelSuggestedDeletes: chunkStats.reduce(
				(sum, stat) => sum + stat.modelSuggested,
				0,
			),
			modelAcceptedDeletes: chunkStats.reduce(
				(sum, stat) => sum + stat.modelAccepted,
				0,
			),
			protectedRestores: chunkStats.reduce(
				(sum, stat) => sum + stat.protectedRestores,
				0,
			),
		},
		numbers: {
			inputDistinct: inputNumbers.length,
			missingCount: missingNumbers.length,
			missing: missingNumbers,
		},
		entityLikeTokens: {
			inputDistinct: inputEntities.length,
			missingCount: missingEntities.length,
			missing: missingEntities,
		},
		acknowledgements: {
			inputStandaloneAckLines: countStandaloneAckLines(inputTexts),
			outputStandaloneAckParagraphs: countStandaloneAckLines(paragraphs),
			outputSamples: standaloneAckSamples(paragraphs),
		},
	};

	console.log(JSON.stringify(summary, null, 2));

	if (missingNumbers.length > 0 || missingEntities.length > 0) {
		process.exit(1);
	}
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
