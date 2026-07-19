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

const parts = new Map(); // partNumber -> Buffer
const manifest = {
	createVideo: null, // {recordingMode, extensionContext, meetingId, name}
	completeMultipart: null, // {durationInSecs, partCount}
	recordingComplete: false,
	assembledFile: null,
};

const save = () =>
	writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

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
		manifest.createVideo = {
			recordingMode: url.searchParams.get("recordingMode"),
			name: url.searchParams.get("name"),
			extensionContext: url.searchParams.get("extensionContext"),
			meetingId: url.searchParams.get("meetingId"),
		};
		save();
		return json(res, { id: "proof-video-1", user_id: "proof-user" });
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
		res.writeHead(200, { ETag: `"etag-${partNumber}"` });
		return res.end();
	}
	if (path === "/api/upload/multipart/complete") {
		const body = JSON.parse((await readBody(req)).toString() || "{}");
		const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]);
		const assembled = Buffer.concat(ordered.map(([, b]) => b));
		const file = join(outDir, "recording.bin");
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
