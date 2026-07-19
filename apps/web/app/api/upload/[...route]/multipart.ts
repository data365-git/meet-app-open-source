import { updateIfDefined } from "@cap/database";
import * as Db from "@cap/database/schema";
import {
	Database,
	makeCurrentUserLayer,
	provideOptionalAuth,
	Storage,
	VideosPolicy,
	VideosRepo,
} from "@cap/web-backend";
import { Policy, Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Effect, Option, Schedule } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import { invalidateGoogleDriveStorageQuotaCache } from "@/lib/google-drive-storage-quota";
import { runPromise } from "@/lib/server";
import { checkUploadQuota } from "@/lib/storage-quota";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { stringOrNumberOptional } from "@/utils/zod";
import {
	getMultipartFileKey,
	getSubpath,
	isRawRecorderUpload,
	isSequentialPartList,
} from "./multipart-utils";

export const app = new Hono().use(withAuth);

const runPromiseAnyEnv = runPromise as <A, E>(
	effect: Effect.Effect<A, E, unknown>,
) => Promise<A>;

/**
 * (H3) True when a storage failure means the multipart upload no longer
 * exists. S3/R2 answer NoSuchUpload for an upload that was aborted AND for one
 * that already completed — and "already completed" is exactly what a lost
 * completion response leaves behind. Errors arrive wrapped (StorageError ->
 * S3Error -> the AWS error), so walk the cause chain.
 */
function isMissingMultipartUploadError(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;

	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const candidate = current as {
			name?: unknown;
			Code?: unknown;
			message?: unknown;
			cause?: unknown;
		};

		if (
			candidate.name === "NoSuchUpload" ||
			candidate.Code === "NoSuchUpload" ||
			(typeof candidate.message === "string" &&
				candidate.message.includes("NoSuchUpload"))
		) {
			return true;
		}

		current = candidate.cause;
	}

	return false;
}

const abortRequestSchema = z
	.object({
		uploadId: z.string(),
	})
	.and(
		z.union([
			z.object({ videoId: z.string(), subpath: z.string().optional() }),
			// deprecated
			z.object({ fileKey: z.string() }),
		]),
	);

type AbortRequestInput = z.input<typeof abortRequestSchema>;

type AbortValidatorInput = {
	in: { json: AbortRequestInput };
	out: { json: z.output<typeof abortRequestSchema> };
};

const abortRequestValidator = zValidator(
	"json",
	abortRequestSchema,
) as MiddlewareHandler<Record<string, never>, "/abort", AbortValidatorInput>;

app.post(
	"/initiate",
	zValidator(
		"json",
		z.object({ contentType: z.string() }).and(
			z.union([
				z.object({ videoId: z.string(), subpath: z.string().optional() }),
				// deprecated
				z.object({ fileKey: z.string() }),
			]),
		),
	),
	async (c) => {
		const { contentType, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = getMultipartFileKey(user.id, body);

		const videoIdFromFileKey = fileKey.split("/")[1];
		const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
		if (!videoIdRaw) return c.text("Video id not found", 400);
		const videoId = Video.VideoId.make(videoIdRaw);

		const resp = await Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const policy = yield* VideosPolicy;
			const db = yield* Database;

			const video = yield* repo
				.getById(videoId)
				.pipe(Policy.withPolicy(policy.isOwner(videoId)));
			if (Option.isNone(video)) return yield* new Video.NotFoundError();

			yield* db.use((db) =>
				db
					.insert(Db.videoUploads)
					.values({
						videoId: video.value[0].id,
						mode: "multipart",
					})
					.onDuplicateKeyUpdate({
						set: {
							mode: "multipart",
							updatedAt: new Date(),
						},
					}),
			);
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchAll((e) => {
				if (e._tag === "VideoNotFoundError")
					return Effect.succeed<Response>(c.text("Video not found", 404));

				return Effect.succeed<Response>(
					c.json({ error: "Error initiating multipart upload" }, 500),
				);
			}),
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
		if (resp) return resp;

		try {
			try {
				const uploadId = await Effect.gen(function* () {
					const repo = yield* VideosRepo;
					const policy = yield* VideosPolicy;
					const maybeVideo = yield* repo
						.getById(videoId)
						.pipe(Policy.withPolicy(policy.isOwner(videoId)));
					if (Option.isNone(maybeVideo)) {
						return yield* new Video.NotFoundError();
					}
					const [video] = maybeVideo.value;
					const [bucket] = yield* Storage.getAccessForVideo(video);

					const finalContentType = contentType || "video/mp4";
					console.log(
						`Creating multipart upload in bucket: ${bucket.bucketName}, content-type: ${finalContentType}, key: ${fileKey}`,
					);

					const { UploadId } = yield* bucket.multipart.create(fileKey, {
						ContentType: finalContentType,
						Metadata: {
							userId: user.id,
							source: "cap-multipart-upload",
						},
						CacheControl: "max-age=31536000",
					});

					if (!UploadId) {
						throw new Error("No UploadId returned from S3");
					}

					console.log(
						`Successfully initiated multipart upload with ID: ${UploadId}`,
					);
					console.log(
						`Upload details: Bucket=${bucket.bucketName}, Key=${fileKey}, ContentType=${finalContentType}`,
					);

					return { uploadId: UploadId, provider: bucket.provider };
				}).pipe(
					Effect.provide(makeCurrentUserLayer(user)),
					provideOptionalAuth,
					runPromiseAnyEnv,
				);

				return c.json(uploadId);
			} catch (s3Error) {
				console.error("S3 operation failed:", s3Error);
				throw new Error(
					`S3 operation failed: ${
						s3Error instanceof Error ? s3Error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			console.error("Error initiating multipart upload", error);
			return c.json(
				{
					error: "Error initiating multipart upload",
					details: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	},
);

app.post(
	"/presign-part",
	zValidator(
		"json",
		z
			.object({
				uploadId: z.string(),
				partNumber: z.number(),
				// deprecated
				md5Sum: z.string().optional(),
			})
			.and(
				z.union([
					z.object({ videoId: z.string(), subpath: z.string().optional() }),
					// deprecated
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	async (c) => {
		const { uploadId, partNumber, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = getMultipartFileKey(user.id, body);

		try {
			try {
				const presignedUrl = await Effect.gen(function* () {
					const videoIdFromFileKey = fileKey.split("/")[1];
					const videoIdRaw =
						"videoId" in body ? body.videoId : videoIdFromFileKey;
					if (!videoIdRaw) throw new Error("Video id not found");
					const videoId = Video.VideoId.make(videoIdRaw);
					const repo = yield* VideosRepo;
					const policy = yield* VideosPolicy;
					const maybeVideo = yield* repo
						.getById(videoId)
						.pipe(Policy.withPolicy(policy.isOwner(videoId)));
					if (Option.isNone(maybeVideo)) {
						return yield* new Video.NotFoundError();
					}
					const [video] = maybeVideo.value;
					const [bucket] = yield* Storage.getAccessForVideo(video);

					console.log(
						`Getting presigned URL for part ${partNumber} of upload ${uploadId}`,
					);

					const presignedUrl =
						yield* bucket.multipart.getPresignedUploadPartUrl(
							fileKey,
							uploadId,
							partNumber,
							{ ContentMD5: body.md5Sum },
						);

					return { presignedUrl, provider: bucket.provider };
				}).pipe(
					Effect.provide(makeCurrentUserLayer(user)),
					provideOptionalAuth,
					runPromiseAnyEnv,
				);

				return c.json(presignedUrl);
			} catch (s3Error) {
				console.error("S3 operation failed:", s3Error);
				throw new Error(
					`S3 operation failed: ${
						s3Error instanceof Error ? s3Error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			console.error("Error creating presigned URL for part", error);
			return c.json(
				{
					error: "Error creating presigned URL for part",
					details: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	},
);

app.post(
	"/complete",
	zValidator(
		"json",
		z
			.object({
				uploadId: z.string(),
				parts: z
					.array(
						z.object({
							partNumber: z.number(),
							etag: z.string(),
							size: z.number(),
						}),
					)
					// A completed multipart upload MUST have >=1 part; an empty array
					// is forwarded to S3 as a malformed completion and yields a broken
					// 0-byte object. Reject it cleanly instead (C8).
					.min(1, "A completed upload must include at least one part"),
				durationInSecs: stringOrNumberOptional,
				width: stringOrNumberOptional,
				height: stringOrNumberOptional,
				fps: stringOrNumberOptional,
			})
			.and(
				z.union([
					z.object({ videoId: z.string(), subpath: z.string().optional() }),
					// deprecated
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	(c) => {
		const { uploadId, parts, ...body } = c.req.valid("json");
		const user = c.get("user");

		return Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const policy = yield* VideosPolicy;
			const db = yield* Database;

			const fileKey = getMultipartFileKey(user.id, body);
			const subpath = getSubpath(body) ?? "result.mp4";

			const videoIdFromFileKey = fileKey.split("/")[1];
			const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
			if (!videoIdRaw) return c.text("Video id not found", 400);
			const videoId = Video.VideoId.make(videoIdRaw);

			const maybeVideo = yield* repo
				.getById(videoId)
				.pipe(Policy.withPolicy(policy.isOwner(videoId)));
			if (Option.isNone(maybeVideo)) {
				c.status(404);
				return c.text(`Video '${encodeURIComponent(videoId)}' not found`);
			}
			const [video] = maybeVideo.value;

			return yield* Effect.gen(function* () {
				const [bucket] = yield* Storage.getAccessForVideo(video);
				const incomingBytes = parts.reduce((acc, part) => acc + part.size, 0);
				const quotaCheck = yield* Effect.promise(() =>
					checkUploadQuota({
						orgId: video.orgId,
						userId: video.ownerId,
						incomingBytes,
					}),
				);
				if (!quotaCheck.ok) {
					return c.json(
						{
							error: quotaCheck.message,
							reason: quotaCheck.reason,
						},
						413,
					);
				}

				// Last line of defence against a gapped part list (e.g. a mis-built
				// client retry path): reject before completeMultipart, which would
				// otherwise fail or assemble a corrupt object (P3.3).
				if (!isSequentialPartList(parts)) {
					return c.json(
						{
							error: "Part numbers are not sequential",
						},
						400,
					);
				}

				const { result, formattedParts } = yield* Effect.gen(function* () {
					console.log(
						`Completing multipart upload ${uploadId} with ${parts.length} parts for key: ${fileKey}`,
					);

					const totalSize = parts.reduce((acc, part) => acc + part.size, 0);
					console.log(`Total size of all parts: ${totalSize} bytes`);

					const sortedParts = [...parts].sort(
						(a, b) => a.partNumber - b.partNumber,
					);

					const needsEtagResolution = sortedParts.some(
						(p) => !p.etag || p.etag === "RESOLVE_SERVER_SIDE",
					);

					let formattedParts: { PartNumber: number; ETag: string }[];

					if (needsEtagResolution) {
						// The browser-extension uploader cannot always read the ETag
						// response header from the cross-origin S3 PUT (it depends on the
						// bucket's CORS ExposeHeaders config), so it records a placeholder
						// "RESOLVE_SERVER_SIDE" ETag. Resolve those server-side via
						// listParts before completing — S3 rejects completion with a
						// placeholder/empty ETag, which would break the F006 retry path.
						console.log(
							"Client sent placeholder ETags — resolving real ETags via listParts",
						);

						const listed = yield* bucket.multipart.listParts(
							fileKey,
							uploadId,
						);
						const etagByPartNumber = new Map<number, string>();
						for (const part of listed.Parts ?? []) {
							if (part.PartNumber !== undefined && part.ETag) {
								etagByPartNumber.set(part.PartNumber, part.ETag);
							}
						}

						formattedParts = sortedParts.map((part) => {
							const isPlaceholder =
								!part.etag || part.etag === "RESOLVE_SERVER_SIDE";
							const resolvedEtag = isPlaceholder
								? etagByPartNumber.get(part.partNumber)
								: part.etag;

							if (!resolvedEtag) {
								throw new Error(
									`Unable to resolve ETag for part ${part.partNumber}; it was not found in the multipart upload`,
								);
							}

							return {
								PartNumber: part.partNumber,
								ETag: resolvedEtag,
							};
						});

						console.log(
							`Resolved ${formattedParts.length} part ETags via listParts`,
						);
					} else {
						formattedParts = sortedParts.map((part) => ({
							PartNumber: part.partNumber,
							ETag: part.etag,
						}));
					}

					console.log(
						"Sending to S3:",
						JSON.stringify(
							{
								Bucket: bucket.bucketName,
								Key: fileKey,
								UploadId: uploadId,
								Parts: formattedParts,
							},
							null,
							2,
						),
					);

					const result = yield* bucket.multipart.complete(fileKey, uploadId, {
						MultipartUpload: {
							Parts: formattedParts,
						},
						...(bucket.provider === "googleDrive"
							? { MpuObjectSize: totalSize }
							: {}),
					});
					yield* Effect.promise(() =>
						invalidateGoogleDriveStorageQuotaCache(
							Option.getOrNull(video.storageIntegrationId),
						),
					);

					return { result, formattedParts };
				}).pipe(
					Effect.catchAll((completeError) => {
						// (H3) Completion must be idempotent. Storage can assemble the
						// object and still lose the response (network drop, gateway
						// timeout); the client then retries with the same uploadId and
						// gets NoSuchUpload — from listParts on the extension's
						// placeholder-ETag path, or from complete itself. Reporting 500
						// forever makes EVERY retry fail until the client dead-letters a
						// meeting whose bytes are all safely in storage: the worst
						// failure this product has. So probe for the finished object
						// under this user-scoped key and, if it is there with real
						// content, carry on down the success path — which also runs the
						// DB and processing side-effects the lost response skipped.
						// Anything else (including a still-open upload that merely
						// erred) keeps failing, so the client retries against a live
						// multipart instead of being told a lie.
						if (!isMissingMultipartUploadError(completeError))
							return Effect.fail(completeError);

						return bucket.headObject(fileKey).pipe(
							Effect.flatMap((head) =>
								(head.ContentLength ?? 0) > 0
									? Effect.logWarning(
											`Multipart upload ${uploadId} no longer exists, but ${fileKey} is already assembled (ContentLength=${head.ContentLength}) — reconciling as an already-completed upload.`,
										)
									: Effect.fail(completeError),
							),
							Effect.map(() => ({
								result: { Location: undefined },
								formattedParts: parts.map((part) => ({
									PartNumber: part.partNumber,
									ETag: part.etag,
								})),
							})),
							Effect.catchAll(() => Effect.fail(completeError)),
						);
					}),
				);

				return yield* Effect.gen(function* () {
					console.log(
						`Multipart upload completed successfully: ${
							result.Location || "no location"
						}`,
					);
					console.log(`Complete response: ${JSON.stringify(result, null, 2)}`);

					// D3a: if we still can't verify the S3 object after retries, fail the
					// request instead of proceeding — otherwise we'd mark the upload
					// complete in the DB while the underlying file may not exist
					// (a DB-row-without-file / "NoSuchKey" bug).
					const headResult = yield* bucket.headObject(fileKey).pipe(
						Effect.tap((headResult) =>
							Effect.log(
								`Object verification successful: ContentType=${headResult.ContentType}, ContentLength=${headResult.ContentLength}`,
							),
						),
						Effect.retry({
							times: 3,
							schedule: Schedule.exponential("50 millis"),
						}),
						Effect.tapError((headError) =>
							Effect.logError(`Unable to verify object: ${headError}`),
						),
					);

					// (H5) Storage is the only trustworthy source of the stored size.
					// The browser extension declares size: 0 for every part, so the
					// client sum records 0 bytes of usage and makes the quota
					// unenforceable. The object is already assembled by this point, so
					// a mismatch is logged rather than rejected — failing here would
					// throw away a recording that is safely stored, which is never the
					// right trade.
					const storedBytes = headResult.ContentLength ?? incomingBytes;
					if (
						headResult.ContentLength !== undefined &&
						incomingBytes > 0 &&
						headResult.ContentLength !== incomingBytes
					) {
						yield* Effect.logWarning(
							`Client declared ${incomingBytes} bytes for ${fileKey} but storage holds ${headResult.ContentLength} — recording the storage value.`,
						);
					}

					if (isRawRecorderUpload(subpath)) {
						yield* db.use((db) =>
							db.transaction(() =>
								Promise.all([
									db
										.update(Db.videos)
										.set({
											duration: updateIfDefined(
												body.durationInSecs,
												Db.videos.duration,
											),
											width: updateIfDefined(body.width, Db.videos.width),
											height: updateIfDefined(body.height, Db.videos.height),
											fps: updateIfDefined(body.fps, Db.videos.fps),
										})
										.where(
											and(
												eq(Db.videos.id, Video.VideoId.make(videoId)),
												eq(Db.videos.ownerId, user.id),
											),
										),
									db
										.update(Db.videoUploads)
										.set({
											uploaded: storedBytes,
											total: storedBytes,
											updatedAt: new Date(),
										})
										.where(
											eq(Db.videoUploads.videoId, Video.VideoId.make(videoId)),
										),
								]),
							),
						);

						const processingStarted = yield* Effect.tryPromise(() =>
							startVideoProcessingWorkflow({
								videoId: Video.VideoId.make(videoId),
								userId: user.id,
								rawFileKey: fileKey,
								bucketId: Option.getOrNull(video.bucketId),
								processingMessage: "Starting video processing...",
								startFailureMessage:
									"Video uploaded, but processing could not start.",
								mode: "multipart",
							}),
						).pipe(
							Effect.map(() => true),
							Effect.catchAll((error) =>
								Effect.logError(
									"Failed to start video processing workflow after raw upload completion",
									error,
								).pipe(Effect.map(() => false)),
							),
						);

						return c.json({
							location: result.Location,
							success: true,
							fileKey,
							processingStarted,
						});
					}

					if (bucket.provider === "s3") {
						console.log(
							"Performing metadata fix by copying the object to itself...",
						);

						yield* bucket
							.copyObject(`${bucket.bucketName}/${fileKey}`, fileKey, {
								ContentType: "video/mp4",
								MetadataDirective: "REPLACE",
							})
							.pipe(
								Effect.tap((result) =>
									Effect.log("Copy for metadata fix successful:", result),
								),
								Effect.catchAll((e) =>
									Effect.logError(
										"Warning: Failed to copy object to fix metadata:",
										e,
									),
								),
								Effect.retry({
									times: 3,
									schedule: Schedule.exponential("50 millis"),
								}),
							);
					}

					yield* db.use((db) =>
						db
							.update(Db.videos)
							.set({
								duration: updateIfDefined(
									body.durationInSecs,
									Db.videos.duration,
								),
								width: updateIfDefined(body.width, Db.videos.width),
								height: updateIfDefined(body.height, Db.videos.height),
								fps: updateIfDefined(body.fps, Db.videos.fps),
							})
							.where(
								and(
									eq(Db.videos.id, Video.VideoId.make(videoId)),
									eq(Db.videos.ownerId, user.id),
								),
							),
					);

					// This is the extension (subpath "result.mp4") and import finalize
					// path — the raw file just landed directly at the "result.mp4" key
					// with no server-side optimization yet. Route it through the same
					// processing workflow as the raw-recorder branch above (instead of
					// deleting the videoUploads row directly) so:
					//  1) processVideoWorkflow actually remuxes/re-encodes it (fixes
					//     iPhone/VP9 playback, sets a real duration) before the row is
					//     cleared, and
					//  2) mode:"multipart" makes the videoUploads row's "processing"
					//     phase block a manual AI-analysis click for the whole remux
					//     window, regardless of whether the upload that got us here was
					//     truly multipart — see lib/transcribe.ts's isUploadInProgress,
					//     which otherwise treats a byte-complete "singlepart" row as NOT
					//     in progress even while phase="processing" (the escape a manual
					//     "AI tahlil" click could race through mid-overwrite).
					const processingStarted = yield* Effect.tryPromise(() =>
						startVideoProcessingWorkflow({
							videoId: Video.VideoId.make(videoId),
							userId: user.id,
							rawFileKey: fileKey,
							bucketId: Option.getOrNull(video.bucketId),
							processingMessage: "Starting video processing...",
							startFailureMessage:
								"Video uploaded, but processing could not start.",
							mode: "multipart",
						}),
					).pipe(
						Effect.map(() => true),
						Effect.catchAll((error) =>
							Effect.logError(
								"Failed to start video processing workflow after multipart completion",
								error,
							).pipe(Effect.map(() => false)),
						),
					);

					return c.json({
						location: result.Location,
						success: true,
						fileKey,
						processingStarted,
					});
				}).pipe(
					Effect.catchAllCause((completeError) => {
						console.error(
							"Failed to complete multipart upload:",
							completeError,
						);
						return Effect.succeed(
							c.json(
								{
									error: "Failed to complete multipart upload",
									details:
										completeError instanceof Error
											? completeError.message
											: String(completeError),
									uploadId,
									fileKey,
									parts: formattedParts.length,
								},
								500,
							),
						);
					}),
				);
			}).pipe(
				Effect.catchAll((error) => {
					console.error("Multipart upload failed:", error);

					return Effect.succeed(
						c.json(
							{
								error: "Error completing multipart upload",
								details: error instanceof Error ? error.message : String(error),
							},
							500,
						),
					);
				}),
			);
		}).pipe(
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
	},
);

app.post("/abort", abortRequestValidator, (c) => {
	const { uploadId, ...body } = c.req.valid("json");
	const user = c.get("user");

	const fileKey = getMultipartFileKey(user.id, body);

	const videoIdFromFileKey = fileKey.split("/")[1];
	const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
	if (!videoIdRaw) return c.text("Video id not found", 400);
	const videoId = Video.VideoId.make(videoIdRaw);

	return Effect.gen(function* () {
		const repo = yield* VideosRepo;
		const policy = yield* VideosPolicy;
		const db = yield* Database;

		const maybeVideo = yield* repo
			.getById(videoId)
			.pipe(Policy.withPolicy(policy.isOwner(videoId)));
		if (Option.isNone(maybeVideo)) {
			c.status(404);
			return c.text(`Video '${encodeURIComponent(videoId)}' not found`);
		}
		const [video] = maybeVideo.value;

		const [bucket] = yield* Storage.getAccessForVideo(video);
		type MultipartWithAbort = typeof bucket.multipart & {
			abort: (
				...args: Parameters<typeof bucket.multipart.complete>
			) => ReturnType<typeof bucket.multipart.complete>;
		};
		const multipart = bucket.multipart as MultipartWithAbort;

		console.log(`Aborting multipart upload ${uploadId} for key: ${fileKey}`);
		yield* multipart.abort(fileKey, uploadId);

		yield* db.use((db) =>
			db.delete(Db.videoUploads).where(eq(Db.videoUploads.videoId, videoId)),
		);

		return c.json({ success: true, fileKey, uploadId });
	}).pipe(
		Effect.catchAll((error) => {
			console.error("Failed to abort multipart upload:", error);

			return Effect.succeed(
				c.json(
					{
						error: "Failed to abort multipart upload",
						details: error instanceof Error ? error.message : String(error),
					},
					500,
				),
			);
		}),
		Effect.provide(makeCurrentUserLayer(user)),
		provideOptionalAuth,
		runPromiseAnyEnv,
	);
});
