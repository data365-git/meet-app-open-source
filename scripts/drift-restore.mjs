// Companion to drift-fetch.mjs — puts a VTT BACK into storage, so "we backed up
// the transcript before re-transcribing" is a reversible claim rather than a
// hopeful one. Runs INSIDE the app container (same credentials, same SDK).
//
//   node drift-restore.mjs <ownerId> <videoId> <localVttPath> [--key <suffix>]
//
// Default target is the real transcript object
// (<ownerId>/<videoId>/transcription.vtt). Pass --key to write somewhere else,
// which is how the mechanism gets PROVEN without overwriting anything real:
//
//   node drift-restore.mjs OWNER VIDEO /tmp/x.vtt --key restore-test.vtt
//
// Written 2026-07-20, when a re-transcription was about to overwrite a real
// 53-minute meeting's transcript and the only backup had no tested way home.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/app/apps/web/package.json");
const { S3Client, PutObjectCommand, GetObjectCommand } = require(
	"@aws-sdk/client-s3",
);

const [ownerId, videoId, vttPath] = process.argv.slice(2);
const keyFlagIndex = process.argv.indexOf("--key");
const keySuffix =
	keyFlagIndex > -1 ? process.argv[keyFlagIndex + 1] : "transcription.vtt";

if (!ownerId || !videoId || !vttPath) {
	console.error(
		"usage: node drift-restore.mjs <ownerId> <videoId> <localVttPath> [--key <suffix>]",
	);
	process.exit(2);
}

const s3 = new S3Client({
	region: process.env.CAP_AWS_REGION,
	endpoint: process.env.CAP_AWS_ENDPOINT || undefined,
	forcePathStyle: process.env.S3_PATH_STYLE === "true",
	credentials: {
		accessKeyId: process.env.CAP_AWS_ACCESS_KEY,
		secretAccessKey: process.env.CAP_AWS_SECRET_KEY,
	},
});

const Bucket = process.env.CAP_AWS_BUCKET;
const Key = `${ownerId}/${videoId}/${keySuffix}`;
const body = readFileSync(vttPath);

await s3.send(
	new PutObjectCommand({
		Bucket,
		Key,
		Body: body,
		ContentType: "text/vtt",
	}),
);

// Read it straight back: a PUT that "succeeded" but stored nothing readable is
// exactly the kind of restore that is discovered at the worst moment.
const got = await s3.send(new GetObjectCommand({ Bucket, Key }));
const chunks = [];
for await (const c of got.Body) chunks.push(c);
const readBack = Buffer.concat(chunks);

const ok = readBack.length === body.length;
console.log(
	`RESTORE ${ok ? "OK" : "MISMATCH"} key=${Key} wrote=${body.length} readBack=${readBack.length}`,
);
process.exit(ok ? 0 : 1);
