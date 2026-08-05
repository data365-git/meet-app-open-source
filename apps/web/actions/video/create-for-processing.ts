"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	sharedVideos,
	spaceVideos,
	videos,
	videoUploads,
} from "@cap/database/schema";
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
import { titleFromFileName } from "@/lib/video-title";
import { resolveVideoFolderAssignment } from "@/lib/video-folder-assignment";

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

export async function createVideoForServerProcessing({
	duration,
	resolution,
	folderId,
	orgId,
	isAudio,
	mimeType,
	fileName,
}: {
	duration?: number;
	resolution?: string;
	folderId?: Folder.FolderId;
	orgId: Organisation.OrganisationId;
	isAudio?: boolean;
	mimeType?: string;
	/** The name of the file the user chose, e.g. "Bitrix24 meeting.mp4". Used as
	 *  the recording's starting title. Untrusted client input — sanitised below. */
	fileName?: string;
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

	const rawFileKey = `${user.id}/${videoId}/raw-upload.mp4`;

	// Storage key/pathway stays the video-shaped "raw-upload.mp4" for both media
	// types — the S3 object's Content-Type metadata (below) carries the real
	// audio format; downstream raw-file lookups (video-proxy, playlist,
	// transcribe) only recognize the .mp4/.webm raw-upload keys, so an
	// audio-specific extension here would break those fallbacks.
	const contentType = isAudio
		? mimeType?.startsWith("audio/")
			? mimeType
			: "audio/mpeg"
		: "video/mp4";

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

	const folderAssignment = await resolveVideoFolderAssignment({
		folderId,
		orgId,
	});

	await db().transaction(async (tx) => {
		await tx.insert(videos).values({
			id: videoId,
			name:
				titleFromFileName(fileName) ??
				`data365 ${isAudio ? "Audio " : ""}Upload - ${formattedDate}`,
			ownerId: user.id,
			orgId,
			source: { type: "webMP4" as const },
			bucket: Option.getOrNull(uploadResult.bucketId),
			storageIntegrationId: Option.getOrNull(uploadResult.storageIntegrationId),
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			...(isAudio ? { metadata: { isAudio: true } } : {}),
			...(folderAssignment.type === "video"
				? { folderId: folderAssignment.folderId }
				: {}),
		});

		if (folderAssignment.type === "organization") {
			await tx.insert(sharedVideos).values({
				id: nanoId(),
				videoId,
				folderId: folderAssignment.folderId,
				organizationId: folderAssignment.organizationId,
				sharedByUserId: user.id,
			});
		} else if (folderAssignment.type === "space") {
			await tx.insert(spaceVideos).values({
				id: nanoId(),
				videoId,
				folderId: folderAssignment.folderId,
				spaceId: folderAssignment.spaceId,
				addedById: user.id,
			});
		}

		await tx.insert(videoUploads).values({
			videoId,
			mode: "singlepart",
			phase: "uploading",
			processingProgress: 0,
			rawFileKey,
		});
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
