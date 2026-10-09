export interface CompletedPartInput {
	ETag: string;
	PartNumber: number;
}

export interface CreateVideoResponse {
	id: string;
	user_id: string;
}

export interface InitiateMultipartResponse {
	uploadId: string;
	provider: string;
}

export interface PresignPartResponse {
	presignedUrl: string;
	provider: string;
}

export interface CompleteMultipartResponse {
	location: string | undefined;
	success: boolean;
	fileKey: string;
}

export interface CapApi {
	createVideo(params: {
		recordingMode: string;
		name?: string;
		extensionContext?: string;
		meetingId?: string;
	}): Promise<CreateVideoResponse>;
	initiateMultipart(params: {
		contentType: string;
		videoId: string;
		subpath?: string;
	}): Promise<InitiateMultipartResponse>;
	presignPart(params: {
		uploadId: string;
		partNumber: number;
		videoId: string;
		subpath?: string;
	}): Promise<PresignPartResponse>;
	completeMultipart(params: {
		uploadId: string;
		parts: Array<{ partNumber: number; etag: string; size: number }>;
		videoId: string;
		subpath?: string;
		/** Elapsed recording seconds (rounded, > 0). Powers the seek bar before
		 * the AI processing pipeline derives it from the actual media. Omitted
		 * when no real elapsed time was available. */
		durationInSecs?: number;
	}): Promise<CompleteMultipartResponse>;
	recordingComplete(params: { videoId: string }): Promise<void>;
	/** Abort the server-side multipart so R2 stops holding the uploaded parts.
	 * Used only by the "permanently discard" flow. */
	abortMultipart(params: {
		uploadId: string;
		videoId: string;
		subpath?: string;
	}): Promise<void>;
	/** Delete the video record and its stored object. Used only by the
	 * "permanently discard" flow, and needed in addition to abortMultipart
	 * because the multipart may already have been completed. */
	deleteVideo(params: { videoId: string }): Promise<void>;
}

async function handleResponse<T>(res: Response, label: string): Promise<T> {
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`[api] ${label} failed ${res.status}: ${body}`);
	}
	return res.json() as Promise<T>;
}

export function createCapApi(baseUrl: string, apiKey: string): CapApi {
	const authHeader = { Authorization: `Bearer ${apiKey}` };

	return {
		async createVideo({ recordingMode, name, extensionContext, meetingId }) {
			const url = new URL(`${baseUrl}/api/desktop/video/create`);
			url.searchParams.set("recordingMode", recordingMode);
			if (name) url.searchParams.set("name", name);
			if (extensionContext)
				url.searchParams.set("extensionContext", extensionContext);
			if (meetingId) url.searchParams.set("meetingId", meetingId);

			const res = await fetch(url.toString(), {
				headers: authHeader,
			});
			return handleResponse<CreateVideoResponse>(res, "createVideo");
		},

		async initiateMultipart({ contentType, videoId, subpath }) {
			const body: Record<string, string> = { contentType, videoId };
			if (subpath) body.subpath = subpath;

			const res = await fetch(`${baseUrl}/api/upload/multipart/initiate`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return handleResponse<InitiateMultipartResponse>(
				res,
				"initiateMultipart",
			);
		},

		async presignPart({ uploadId, partNumber, videoId, subpath }) {
			const body: Record<string, string | number> = {
				uploadId,
				partNumber,
				videoId,
			};
			if (subpath) body.subpath = subpath;

			const res = await fetch(`${baseUrl}/api/upload/multipart/presign-part`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return handleResponse<PresignPartResponse>(res, "presignPart");
		},

		async completeMultipart({ uploadId, parts, videoId, subpath, durationInSecs }) {
			const body: Record<string, unknown> = { uploadId, parts, videoId };
			if (subpath) body.subpath = subpath;
			if (durationInSecs !== undefined) body.durationInSecs = durationInSecs;

			const res = await fetch(`${baseUrl}/api/upload/multipart/complete`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return handleResponse<CompleteMultipartResponse>(
				res,
				"completeMultipart",
			);
		},

		async recordingComplete({ videoId }) {
			const res = await fetch(`${baseUrl}/api/upload/recording-complete/`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify({ videoId }),
			});
			if (res.status === 400 || res.status === 409) {
				return;
			}
			await handleResponse<unknown>(res, "recordingComplete");
		},

		async abortMultipart({ uploadId, videoId, subpath }) {
			const body: Record<string, string> = { uploadId, videoId };
			if (subpath) body.subpath = subpath;

			const res = await fetch(`${baseUrl}/api/upload/multipart/abort`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			// 404 means the video is already gone. S3/R2 answer NoSuchUpload for an
			// upload that was already aborted or already COMPLETED - the completed
			// case is the common one when a discard lands late, and the abort route
			// surfaces it as a 500 carrying the message. Both mean "there is no
			// multipart left to abort", which is the outcome we wanted; treating
			// them as failures would raise a false "we could not clean up" alarm on
			// a discard that actually worked.
			if (res.status === 404) return;
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (detail.includes("NoSuchUpload")) return;
				throw new Error(`[api] abortMultipart failed ${res.status}: ${detail}`);
			}
		},

		async deleteVideo({ videoId }) {
			// delete-permanent, NOT /api/video/delete. The latter is a SOFT delete:
			// it moves the row to Trash and keeps the media for seven days so it can
			// be restored. "Permanently discard" said the recording was destroyed
			// while it sat fully recoverable in R2 — and for a confidential meeting
			// that gap is the entire reason the button exists. The permanent route
			// deletes storage first and the row last (so a failed object delete
			// leaves a record to retry from) and succeeds on an already-absent
			// video, which is what makes the offline retry safe.
			const url = new URL(`${baseUrl}/api/video/delete-permanent`);
			url.searchParams.set("videoId", videoId);

			const res = await fetch(url.toString(), {
				method: "DELETE",
				headers: authHeader,
			});
			// Already deleted is the state the caller asked for.
			if (res.status === 404) return;
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw new Error(`[api] deleteVideo failed ${res.status}: ${detail}`);
			}
		},
	};
}
