"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { videos, videoUploads } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { Storage as StorageService } from "@cap/web-backend";
import {
	type Folder,
	type Organisation,
	type Storage,
	Video,
} from "@cap/web-domain";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { runPromise } from "@/lib/server";

export interface CreateForProcessingResult {
	id: Video.VideoId;
	rawFileKey: string;
	bucketId: string | null;
	storageIntegrationId: string | null;
	uploadTarget: Storage.UploadTarget;
	presignedPostData: {
		url: string;
		fields: Record<string, string>;
	} | null;
}

// Map an uploaded file's extension/MIME to a stored extension + content type.
// Supports video and audio; falls back to mp4 for unknown types (legacy-safe).
function resolveMedia(
	fileName?: string,
	mimeType?: string,
): { ext: string; contentType: string } {
	const extToType: Record<string, string> = {
		mp4: "video/mp4",
		mov: "video/quicktime",
		webm: "video/webm",
		mkv: "video/x-matroska",
		avi: "video/x-msvideo",
		m4v: "video/x-m4v",
		mp3: "audio/mpeg",
		m4a: "audio/mp4",
		wav: "audio/wav",
		aac: "audio/aac",
		ogg: "audio/ogg",
	};

	const name = (fileName ?? "").toLowerCase();
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot + 1) : "";
	if (ext && extToType[ext]) {
		return { ext, contentType: extToType[ext] };
	}

	const mimeToExt: Record<string, string> = {
		"video/mp4": "mp4",
		"video/quicktime": "mov",
		"video/webm": "webm",
		"video/x-matroska": "mkv",
		"audio/mpeg": "mp3",
		"audio/mp4": "m4a",
		"audio/x-m4a": "m4a",
		"audio/wav": "wav",
		"audio/x-wav": "wav",
		"audio/aac": "aac",
		"audio/ogg": "ogg",
		"audio/webm": "webm",
	};
	const mime = (mimeType ?? "").toLowerCase();
	if (mime && mimeToExt[mime]) {
		return { ext: mimeToExt[mime], contentType: mime };
	}

	return { ext: "mp4", contentType: "video/mp4" };
}

export async function createVideoForServerProcessing({
	duration,
	resolution,
	folderId,
	orgId,
	fileName,
	contentType: fileContentType,
}: {
	duration?: number;
	resolution?: string;
	folderId?: Folder.FolderId;
	orgId: Organisation.OrganisationId;
	fileName?: string;
	contentType?: string;
}): Promise<CreateForProcessingResult> {
	const user = await getCurrentUser();

	if (!user) throw new Error("Unauthorized");

	if (!userIsPro(user) && duration && duration > 300) {
		throw new Error("upgrade_required");
	}

	await requireOrganizationAccess(user.id, orgId);

	const videoId = Video.VideoId.make(nanoId());

	const date = new Date();
	const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
		month: "long",
	})} ${date.getFullYear()}`;

	const { ext, contentType } = resolveMedia(fileName, fileContentType);
	// Tag audio uploads with a distinct source type so the app can separate
	// audio from video (badge, audio player) — matches v2's `webAudio`.
	const isAudio = contentType.startsWith("audio/");
	const rawFileKey = `${user.id}/${videoId}/raw-upload.${ext}`;

	const uploadResult = await StorageService.createUploadTargetForUser(
		user.id,
		rawFileKey,
		{
			contentType,
			method: "put",
			fields: {
				"x-amz-meta-userid": user.id,
				"x-amz-meta-duration": duration?.toString() ?? "",
				"x-amz-meta-resolution": resolution ?? "",
			},
		},
		orgId,
	).pipe(runPromise);

	await db()
		.insert(videos)
		.values({
			id: videoId,
			name: `Cap Upload - ${formattedDate}`,
			ownerId: user.id,
			orgId,
			source: { type: (isAudio ? "webAudio" : "webMP4") as const },
			bucket: Option.getOrNull(uploadResult.bucketId),
			storageIntegrationId: Option.getOrNull(uploadResult.storageIntegrationId),
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			...(folderId ? { folderId } : {}),
		});

	await db().insert(videoUploads).values({
		videoId,
		mode: "singlepart",
		phase: "uploading",
		processingProgress: 0,
		rawFileKey,
	});

	if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production") {
		await dub()
			.links.create({
				url: `${serverEnv().WEB_URL}/s/${videoId}`,
				domain: "cap.link",
				key: videoId,
			})
			.catch((err) => {
				console.error("Dub link create failed", err);
			});
	}

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/folder");
	revalidatePath("/dashboard/spaces");

	return {
		id: videoId,
		rawFileKey,
		bucketId: Option.getOrNull(uploadResult.bucketId),
		storageIntegrationId: Option.getOrNull(uploadResult.storageIntegrationId),
		uploadTarget: uploadResult.upload,
		presignedPostData:
			uploadResult.upload.type === "s3Post"
				? {
						url: uploadResult.upload.url,
						fields: uploadResult.upload.fields,
					}
				: null,
	};
}
