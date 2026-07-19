// Companion to measure-transcript-drift.mjs — runs INSIDE the app container and
// downloads the two inputs it needs using the app's own storage credentials.
// Read-only. The runtime image ships @aws-sdk/client-s3 but NOT the presigner or
// mysql2, so this streams the objects directly and takes ownerId as an argument
// (query it separately from the mysql container).
//
//   node drift-fetch.mjs <ownerId> <videoId>
//     -> /tmp/<videoId>.vtt and /tmp/<videoId>.mp4, prints VTT= and MEDIA= paths
import { createWriteStream, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";

const require = createRequire("/app/apps/web/package.json");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const [ownerId, videoId] = process.argv.slice(2);
if (!ownerId || !videoId) {
	console.error("usage: node drift-fetch.mjs <ownerId> <videoId>");
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
const base = `${ownerId}/${videoId}`;

const get = (Key) => s3.send(new GetObjectCommand({ Bucket, Key }));

const vtt = await get(`${base}/transcription.vtt`);
const vttPath = `/tmp/${videoId}.vtt`;
writeFileSync(vttPath, await vtt.Body.transformToString());

// Media key depends on the source type (MEASURED on prod 2026-07-19): the
// extension path writes result.mp4; the web recorder writes raw-upload.mp4
// (plus a source/original.mp4 sibling). Try them in order.
const CANDIDATES = [
	`${base}/result.mp4`,
	`${base}/raw-upload.mp4`,
	`${base}/source/original.mp4`,
];
const mediaPath = `/tmp/${videoId}.mp4`;
let media = null;
let usedKey = null;
for (const key of CANDIDATES) {
	try {
		media = await get(key);
		usedKey = key;
		break;
	} catch {}
}
if (!media) {
	console.error(`no media object found under ${base}`);
	process.exit(1);
}
await pipeline(media.Body, createWriteStream(mediaPath));
console.log(`KEY=${usedKey}`);

console.log(`VTT=${vttPath}`);
console.log(`MEDIA=${mediaPath}`);
