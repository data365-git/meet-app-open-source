"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	videos,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	isInMeetingsLibrary,
	validateHermesClientFields,
} from "@/lib/hermes-meeting";
import { getEffectiveOrganizationRole } from "@/lib/permissions/roles";
import { transcribeVideo } from "@/lib/transcribe";
import { patchVideoMetadata } from "@/lib/video-metadata";

/**
 * Server actions behind the "Bu meetingmi? Hermesga joylaymi?" dialog on the
 * video page (ADR 2026-10-08, part A). The permission and Meetings-library
 * rules are enforced HERE, not only in the UI — a "use server" action is a
 * POST endpoint any signed-in user can call with any video id.
 *
 * Metadata discipline: every write goes through patchVideoMetadata (row lock
 * + spread of the freshly-read value) or server-side JSON_SET, so a concurrent
 * AI workflow can never be clobbered and `hermes` can never be dropped by us.
 */

type HermesActionResult =
	| { success: true; hermes: VideoMetadata["hermes"] }
	| { success: false; error: string };

/** Load a live (non-deleted) video with exactly the fields these actions need. */
async function loadVideoForHermes(videoId: string) {
	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			orgId: videos.orgId,
			transcriptionStatus: videos.transcriptionStatus,
			metadata: videos.metadata,
			libraryKind: videos.libraryKind,
			source: videos.source,
		})
		.from(videos)
		.where(
			and(eq(videos.id, videoId as Video.VideoId), isNull(videos.deletedAt)),
		)
		.limit(1);
	return video ?? null;
}

/**
 * Admin rule (ADR: "admins only"): ONLY an owner/admin of the organization
 * that owns the video may answer the dialog or call these actions — the video
 * owner who is not an org admin gets the same refusal as anyone else.
 * Returns an error string instead of throwing so the dialog can show it.
 */
async function hermesPermissionError(
	userId: string,
	video: { ownerId: string; orgId: string | null },
): Promise<string | null> {
	if (!video.orgId) return "Faqat adminlar uchun";

	const [orgAccess] = await db()
		.select({
			ownerId: organizations.ownerId,
			memberRole: organizationMembers.role,
		})
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(
					organizationMembers.userId,
					userId as typeof organizationMembers.$inferSelect.userId,
				),
			),
		)
		.where(
			and(
				eq(
					organizations.id,
					video.orgId as typeof organizations.$inferSelect.id,
				),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);

	if (!orgAccess) return "Faqat adminlar uchun";
	const role = getEffectiveOrganizationRole({
		userId,
		ownerId: orgAccess.ownerId,
		memberRole: orgAccess.memberRole,
	});
	if (role === "owner" || role === "admin") return null;
	return "Faqat adminlar uchun";
}

/** "Yo'q" — record the answer so the dialog never auto-opens again. */
export async function declineHermesMeeting(
	videoId: string,
): Promise<HermesActionResult> {
	try {
		const user = await getCurrentUser();
		if (!user?.id)
			return { success: false, error: "Avtorizatsiya talab qilinadi" };

		const video = await loadVideoForHermes(videoId);
		if (!video) return { success: false, error: "Video topilmadi" };
		if (!isInMeetingsLibrary(video)) {
			return {
				success: false,
				error: "Faqat Meetings kutubxonasidagi videolar uchun",
			};
		}
		const denied = await hermesPermissionError(user.id, video);
		if (denied) return { success: false, error: denied };

		const current = (video.metadata as VideoMetadata) || {};
		if (
			current.hermes?.status === "queued" ||
			current.hermes?.status === "delivered"
		) {
			return {
				success: false,
				error: "Bu video allaqachon Hermesga yuborilgan",
			};
		}

		// Race guard: the status can change between the read above and the
		// locked write below (another admin queues it). Re-check INSIDE the
		// updater; on a race the row is left unchanged and we answer the
		// "allaqachon" error instead of clobbering the queue entry.
		let racedWithQueue = false;
		const next = await patchVideoMetadata(videoId, (cur) => {
			if (cur.hermes?.status === "queued" || cur.hermes?.status === "delivered") {
				racedWithQueue = true;
				return cur;
			}
			return { ...cur, hermes: { status: "declined" } };
		});
		if (racedWithQueue) {
			return {
				success: false,
				error: "Bu video allaqachon Hermesga yuborilgan",
			};
		}

		revalidatePath(`/s/${videoId}`);
		return { success: true, hermes: next.hermes };
	} catch (error) {
		console.error("[hermes-meeting] decline failed:", error);
		return { success: false, error: "Saqlashda xatolik" };
	}
}

/**
 * "Ha, joylash" — queue the transcript for the Mac-side puller and, when the
 * transcript is neither COMPLETE nor already running, start it exactly the
 * way the generate route does in transcript mode: transcribeVideo(..., false,
 * false), plus the same one-shot banked order when the upload is still in
 * flight (so the pipeline picks it up the moment the bytes land).
 */
export async function queueHermesMeeting(
	videoId: string,
	clientName: string,
	company: string,
): Promise<HermesActionResult> {
	try {
		const user = await getCurrentUser();
		if (!user?.id)
			return { success: false, error: "Avtorizatsiya talab qilinadi" };

		const fields = validateHermesClientFields(clientName, company);
		if (!fields) {
			return {
				success: false,
				error: "Mijoz ismi va kompaniya to'ldirilishi shart (60 belgigacha)",
			};
		}

		const video = await loadVideoForHermes(videoId);
		if (!video) return { success: false, error: "Video topilmadi" };
		if (!isInMeetingsLibrary(video)) {
			return {
				success: false,
				error: "Faqat Meetings kutubxonasidagi videolar uchun",
			};
		}
		const denied = await hermesPermissionError(user.id, video);
		if (denied) return { success: false, error: denied };

		const current = (video.metadata as VideoMetadata) || {};
		if (current.hermes?.status === "delivered") {
			return {
				success: false,
				error: "Bu video Hermesga allaqachon joylangan",
			};
		}
		if (current.hermes?.status === "queued") {
			// Idempotent: the dialog/UI re-submitting an already-queued video is
			// a success, not an error — and must not reset queuedAt.
			revalidatePath(`/s/${videoId}`);
			return { success: true, hermes: current.hermes };
		}

		// Transcript: reuse the existing pipeline (generate route, transcript
		// mode). Nothing to do when it is already COMPLETE (the queue route will
		// serve it immediately) or PROCESSING (it will become COMPLETE on its
		// own and the queue picks it up then).
		if (
			video.transcriptionStatus !== "COMPLETE" &&
			video.transcriptionStatus !== "PROCESSING"
		) {
			const result = await transcribeVideo(
				video.id as Video.VideoId,
				video.ownerId,
				false,
				false,
			);
			if (!result.success) {
				return { success: false, error: result.message };
			}
			if (result.code === "UPLOAD_IN_PROGRESS") {
				// Same one-shot banked order the generate route writes in
				// transcript mode: server-side JSON_SET/JSON_REMOVE so nothing
				// read before the lock is written back stale. Hermes wants the
				// transcript ONLY — never bank an AI-generation request. The
				// WHERE keeps it one-shot and polite: if someone else's banked
				// order is already waiting on the upload (a pending FULL-AI
				// run), it is NOT downgraded to transcript-only.
				const now = new Date().toISOString();
				await db()
					.update(videos)
					.set({
						metadata: sql`JSON_REMOVE(
							JSON_SET(
								COALESCE(${videos.metadata}, JSON_OBJECT()),
								'$.aiGenerationRequestedBy', ${user.id},
								'$.aiStartPendingUpload', ${now},
								'$.aiStartMode', 'transcript'
							),
							'$.aiGenerationRequestedAt'
						)`,
					})
					.where(
						and(
							eq(videos.id, video.id),
							sql`JSON_CONTAINS_PATH(COALESCE(${videos.metadata}, JSON_OBJECT()), 'one', '$.aiStartPendingUpload') = 0`,
						),
					);
			}
		}

		const queuedAt = new Date().toISOString();
		// Race guard, same shape as decline: re-check the status INSIDE the
		// locked updater. delivered -> unchanged + error; queued -> unchanged
		// + idempotent success (the FIRST queuer's queuedAt and fields stay).
		let raced: "delivered" | "queued" | null = null;
		const next = await patchVideoMetadata(videoId, (cur) => {
			if (cur.hermes?.status === "delivered") {
				raced = "delivered";
				return cur;
			}
			if (cur.hermes?.status === "queued") {
				raced = "queued";
				return cur;
			}
			return {
				...cur,
				hermes: {
					status: "queued",
					clientName: fields.clientName,
					company: fields.company,
					queuedAt,
				},
			};
		});
		if (raced === "delivered") {
			return {
				success: false,
				error: "Bu video Hermesga allaqachon joylangan",
			};
		}
		if (raced === "queued") {
			revalidatePath(`/s/${videoId}`);
			return { success: true, hermes: next.hermes };
		}

		revalidatePath(`/s/${videoId}`);
		return { success: true, hermes: next.hermes };
	} catch (error) {
		console.error("[hermes-meeting] queue failed:", error);
		return { success: false, error: "Navbatga qo'shishda xatolik" };
	}
}
