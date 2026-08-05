// Mock data365 upload API for the audio-proof harness.
// Implements exactly the endpoints the extension's api.ts calls, stores the
// uploaded parts, assembles them on complete, and records every claim we want
// to verify (extensionContext, meetingId, durationInSecs) into manifest.json.
//
// Usage: node mock-server.mjs [port] [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8787);
const outDir = process.argv[3] ?? join(here, "out");
mkdirSync(outDir, { recursive: true });

let parts = new Map(); // partNumber -> Buffer
// Session counter: PROOF_SECOND records TWICE back-to-back on the same fake
// Meet page. Without per-recording isolation, recording #2's parts Map would
// still hold recording #1's stale high-numbered parts (corrupting assembly)
// and its manifest.json / recording.bin would silently overwrite #1's before
// the harness can read it. Each /api/desktop/video/create bumps the session
// number, clears `parts`, and every subsequent write for that session goes to
// manifest-<n>.json / recording-<n>.bin. Session 1 ALSO writes the original
// manifest.json / recording.bin so run-proof-inpage.mjs's single-recording
// (non-PROOF_SECOND) path keeps working unchanged.
let session = 0;
let manifest = null; // current session's manifest object

// Optional upload throttle for the "network slower than capture bitrate" proof.
// Unset (default) = today's behaviour, unchanged. When set, the PUT part
// handler sleeps for (bytes / (THROTTLE_KBPS*1024/8)) seconds before answering,
// simulating a capped upload link.
const throttleKbps = process.env.THROTTLE_KBPS ? Number(process.env.THROTTLE_KBPS) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const manifestPathFor = (n) => join(outDir, n === 1 ? "manifest.json" : `manifest-${n}.json`);
const recordingPathFor = (n) => join(outDir, n === 1 ? "recording.bin" : `recording-${n}.bin`);

const save = () => {
	writeFileSync(manifestPathFor(session), JSON.stringify(manifest, null, 2));
};

const readBody = (req) =>
	new Promise((resolve) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});

const json = (res, obj, status = 200) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${port}`);
	const path = url.pathname;
	console.log(`[mock] ${req.method} ${path}`);

	// CORS: the extension SW's fetches carry an Authorization header → preflight.
	// (Prod is covered by host_permissions https://*/*; a localhost mock is not.)
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
	res.setHeader("Access-Control-Expose-Headers", "ETag");
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		return res.end();
	}

	if (path === "/api/desktop/video/create") {
		// A new recording session starts here — reset per-session state so a 2nd
		// back-to-back recording (PROOF_SECOND) cannot collide with the 1st's parts.
		session += 1;
		parts = new Map();
		manifest = {
			session,
			createVideo: {
				recordingMode: url.searchParams.get("recordingMode"),
				name: url.searchParams.get("name"),
				extensionContext: url.searchParams.get("extensionContext"),
				meetingId: url.searchParams.get("meetingId"),
			},
			completeMultipart: null,
			recordingComplete: false,
			assembledFile: null,
		};
		save();
		return json(res, { id: `proof-video-${session}`, user_id: "proof-user" });
	}
	if (path === "/api/upload/multipart/initiate") {
		await readBody(req);
		return json(res, { uploadId: "proof-upload-1", provider: "mock" });
	}
	if (path === "/api/upload/multipart/presign-part") {
		const body = JSON.parse((await readBody(req)).toString() || "{}");
		return json(res, {
			presignedUrl: `http://localhost:${port}/mock-part/${body.partNumber}`,
			provider: "mock",
		});
	}
	if (path.startsWith("/mock-part/") && req.method === "PUT") {
		const partNumber = Number(path.split("/").pop());
		const buf = await readBody(req);
		parts.set(partNumber, buf);
		if (throttleKbps) {
			const seconds = buf.length / ((throttleKbps * 1024) / 8);
			await sleep(seconds * 1000);
		}
		res.writeHead(200, { ETag: `"etag-${partNumber}"` });
		return res.end();
	}
	if (path === "/api/upload/multipart/complete") {
		const body = JSON.parse((await readBody(req)).toString() || "{}");
		const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]);
		const assembled = Buffer.concat(ordered.map(([, b]) => b));
		const file = recordingPathFor(session);
		writeFileSync(file, assembled);
		manifest.completeMultipart = {
			durationInSecs: body.durationInSecs ?? null,
			partCount: ordered.length,
			bytes: assembled.length,
		};
		manifest.assembledFile = file;
		save();
		return json(res, { location: file, success: true, fileKey: "proof/result.mp4" });
	}
	if (path === "/api/upload/recording-complete/") {
		await readBody(req);
		manifest.recordingComplete = true;
		save();
		return json(res, {});
	}
	// Anything else (auth checks etc.) — succeed blandly.
	return json(res, { ok: true });
});

server.listen(port, "127.0.0.1", () => {
	console.log(`[mock] up on :${port} -> ${outDir}`);
});
