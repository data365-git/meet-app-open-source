import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { startAiGeneration } from "@/lib/generate-ai";
import { AI_ACCESS_DENIED_CODE, canUseAI } from "@/lib/permissions/ai-access";
import { getEffectiveOrganizationRole } from "@/lib/permissions/roles";
import {
  recordReprocessAttempt,
  REPROCESS_RATE_LIMIT_CODE,
} from "@/lib/reprocess-rate-limit";
import {
  bankedStartRequestsFullAnalysis,
  hasPendingAiGenerationRequest,
} from "@/lib/ai-generation-request";
import {
  currentBillingMonth,
  getAiBudgetCapsMicros,
  getMonthlySpendMicros,
} from "@/lib/ai-cost-guard";
import { transcribeVideo } from "@/lib/transcribe";

/**
 * S2 (owner order 2026-09-25: "pul tugasa pul tugadi desin"): a monthly-cap
 * refusal is NOT a server error. Answer HTTP 402 with a machine code so the
 * panel shows the money truth (with spent/cap numbers) instead of the raw
 * English string — the numbers come from the same cost-guard helpers the
 * refusal itself used, so the line can never disagree with the block.
 */
async function budgetExceededRefusal(video: {
  orgId: string | null;
  ownerId: string;
}): Promise<Response> {
  let spentUsd = 0;
  let capUsd = 0;
  try {
    const month = currentBillingMonth();
    const caps = await getAiBudgetCapsMicros({
      orgId: (video.orgId ?? "") as never,
      userId: video.ownerId,
    });
    const capsList = [
      { cap: caps.budgetCapOrgMicros, org: true },
      { cap: caps.budgetCapUserMicros, org: false },
    ].filter((c): c is { cap: number; org: boolean } => c.cap != null);
    // The EFFECTIVE blocker is the smallest reached cap; show that pair.
    for (const { cap, org } of capsList) {
      const spend = await getMonthlySpendMicros(
        org ? "orgId" : "userId",
        org ? (video.orgId as string) : video.ownerId,
        month,
      );
      if (spend >= cap && (capUsd === 0 || cap / 1e6 < capUsd)) {
        spentUsd = spend / 1e6;
        capUsd = cap / 1e6;
      }
    }
  } catch (error) {
    console.error("[generate] budget numbers lookup failed:", error);
  }
  return Response.json(
    {
      error: "AI budget exceeded",
      code: "AI_BUDGET_EXCEEDED",
      ...(spentUsd > 0 ? { spentUsd, capUsd } : {}),
    },
    { status: 402 },
  );
}

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const { videoId: rawVideoId } = await params;
    const videoId = rawVideoId as Video.VideoId;

    // Owner/admin "Qayta analiz" (retry) re-runs AI on the EXISTING transcript
    // even when content already exists. No re-upload / re-transcription.
    let reprocess = false;
    // Two explicit start modes (2026-09-10): "Only transcript" stops once the
    // transcript is ready; "Full AI analysis" chains the summary and tasks in
    // the same run with no second press. Read exactly like `reprocess` above
    // - a plain body field, the convention this route already uses. An ABSENT
    // mode is a press that did not come from the two-mode chooser (error
    // retry, the banked "press again", legacy callers); each branch below then
    // keeps its own pre-two-modes default or resolves the user's outstanding
    // banked intent instead of guessing.
    let startMode: "transcript" | "full" | null = null;
    try {
      const body = await request.json();
      reprocess = body?.reprocess === true;
      if (body?.mode === "full" || body?.mode === "transcript") {
        startMode = body.mode;
      }
    } catch {
      // no body → normal (non-forced) request
    }

    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (!canUseAI(user)) {
      return Response.json({ error: AI_ACCESS_DENIED_CODE }, { status: 403 });
    }

    const [video] = await db()
      .select({ id: videos.id, ownerId: videos.ownerId, orgId: videos.orgId, transcriptionStatus: videos.transcriptionStatus, metadata: videos.metadata })
      .from(videos)
      .where(and(eq(videos.id, videoId), isNull(videos.deletedAt)))
      .limit(1);

    if (!video) {
      return Response.json({ error: "Video not found" }, { status: 404 });
    }

    // Check admin/owner permission
    const isOwner = user.id === video.ownerId;
    let hasPermission = isOwner;

    if (!hasPermission && video.orgId) {
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
            eq(organizationMembers.userId, user.id),
          ),
        )
        .where(
          and(
            eq(organizations.id, video.orgId),
            isNull(organizations.tombstoneAt),
          ),
        )
        .limit(1);

      if (orgAccess) {
        const role = getEffectiveOrganizationRole({
          userId: user.id,
          ownerId: orgAccess.ownerId,
          memberRole: orgAccess.memberRole,
        });
        hasPermission = role === "owner" || role === "admin";
      }
    }

    if (!hasPermission) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // D8: forced reprocesses are limited to 3/hour per video (in-memory,
    // per-instance). Checked after auth so unauthenticated users can't probe.
    if (reprocess && !recordReprocessAttempt(videoId)) {
      return Response.json(
        { error: REPROCESS_RATE_LIMIT_CODE },
        { status: 429 },
      );
    }

    const existingMetadata = (video.metadata as VideoMetadata) || {};

    // If transcription is still running, remember the user's explicit AI
    // request so the workflow starts AI analysis as soon as the transcript
    // finishes. Do not set aiGenerationStatus=QUEUED here: startAiGeneration
    // uses that status to mean a real AI workflow has already been launched.
    //
    // Server-side JSON_SET, same discipline as transcribeVideo's claim. A
    // plain spread of the row read above would revert everything the workflow
    // wrote between that read and this write (chunk progress, legacy Batch
    // handles). This only records the explicit AI request and backfills the
    // job clock if missing.
    if (video.transcriptionStatus === "PROCESSING") {
      // "Only transcript" pressed while a transcript is already running asks
      // for nothing beyond it: clear any banked AI request so the durable
      // marker's OR in shouldStartAiAfterTranscription cannot re-enable the
      // auto-chain behind the user's back (the 2026-09-05 no-op lesson).
      if (startMode === "transcript") {
        await db()
          .update(videos)
          .set({
            metadata: sql`JSON_REMOVE(
              COALESCE(${videos.metadata}, JSON_OBJECT()),
              '$.aiGenerationRequestedAt'
            )`,
          })
          .where(eq(videos.id, videoId));
        return Response.json({ alreadyRunning: true, transcriptOnly: true });
      }
      const now = new Date().toISOString();
      await db()
        .update(videos)
        .set({
          metadata: sql`JSON_SET(
            COALESCE(${videos.metadata}, JSON_OBJECT()),
            '$.aiGenerationRequestedAt', ${now},
            '$.aiGenerationRequestedBy', ${user.id},
            '$.aiJobStartedAt', COALESCE(
              JSON_UNQUOTE(JSON_EXTRACT(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiJobStartedAt')),
              ${now}
            )
          )`,
        })
        .where(eq(videos.id, videoId));

      return Response.json({ alreadyRunning: true, queuedAfterTranscription: true });
    }

    // If transcription is COMPLETE, check whether AI generation still needs to run
    if (video.transcriptionStatus === "COMPLETE") {
      // "Only transcript" asks for nothing beyond a transcript that already
      // exists: never fall through into an AI run nobody requested (2026-10-07,
      // bulk bar on stale grid data / a stale panel).
      if (startMode === "transcript" && !reprocess) {
        return Response.json({ alreadyRunning: true, transcriptOnly: true });
      }
      const metadata = (video.metadata as VideoMetadata) || {};
      const aiStatus = metadata.aiGenerationStatus;

      // AI already done — only if real content is present (summary or aiSummary).
      // If status is COMPLETE but content is missing/empty, fall through to retry.
      if (aiStatus === "COMPLETE" && !reprocess) {
        const hasContent =
          (typeof metadata.summary === "string" && metadata.summary.length > 0) ||
          (metadata.aiSummary != null &&
            typeof metadata.aiSummary === "object" &&
            typeof (metadata.aiSummary as { overview?: unknown }).overview === "string" &&
            ((metadata.aiSummary as { overview: string }).overview.length > 0));
        if (hasContent) {
          return Response.json({ alreadyRunning: true });
        }
        // COMPLETE but empty — fall through to startAiGeneration below
      }

      // AI in-flight (a forced reprocess must still wait for the running job)
      if (aiStatus === "PROCESSING" || aiStatus === "QUEUED") {
        return Response.json({ alreadyRunning: true });
      }

      // Transcript done but AI missing / ERROR, or an owner-forced reprocess —
      // start/retry AI generation on the existing transcript.
      const result = await startAiGeneration(videoId, video.ownerId, {
        force: reprocess,
      });
      if (!result.success) {
        if (result.message === "AI budget exceeded") {
          return budgetExceededRefusal(video);
        }
        return Response.json({ error: result.message }, { status: 500 });
      }
      return Response.json({ started: true });
    }

    // Transcription not yet started — kick off the pipeline. The chosen mode
    // IS the switch (2026-09-10): "Only transcript" reaches the pipeline with
    // aiGenerationEnabled=false and stops there; "Full AI analysis" reaches it
    // with true, so the workflow chains summary/tasks with no second press.
    // An absent mode resolves the user's OUTSTANDING intent: a durable
    // aiGenerationRequestedAt (banked by a "full" press below or by the
    // already-PROCESSING branch) means the run being retried was a full one;
    // otherwise transcript-only - the first press of the two-mode chooser and
    // what every legacy caller has meant since 2026-09-05.
    const wantsFullAnalysis =
      startMode === "full" ||
      (startMode === null && hasPendingAiGenerationRequest(existingMetadata));
    const result = await transcribeVideo(
      videoId,
      video.ownerId,
      wantsFullAnalysis,
      false,
    );

    if (!result.success) {
      if (result.message === "AI budget exceeded") {
        return budgetExceededRefusal(video);
      }
      return Response.json({ error: result.message }, { status: 500 });
    }

    // Make the chosen mode stick on the row so the durable-marker OR cannot
    // flip it later. A full start banks the durable AI request (this is also
    // what keeps the status poll watching for the transcript-to-QUEUED
    // handoff instead of going terminal mid-gap); an explicit transcript-only
    // start clears any stale AI request left by an earlier press. An absent
    // mode leaves the row as-is - the flag above already matched what was
    // banked. Skipped while the upload is still running: the banking branch
    // below writes its own (mode-carrying) markers.
    if (result.code !== "UPLOAD_IN_PROGRESS") {
      if (wantsFullAnalysis) {
        const now = new Date().toISOString();
        await db()
          .update(videos)
          .set({
            metadata: sql`JSON_SET(
              COALESCE(${videos.metadata}, JSON_OBJECT()),
              '$.aiGenerationRequestedAt', ${now},
              '$.aiGenerationRequestedBy', ${user.id}
            )`,
          })
          .where(eq(videos.id, videoId));
      } else if (startMode === "transcript") {
        await db()
          .update(videos)
          .set({
            metadata: sql`JSON_REMOVE(
              COALESCE(${videos.metadata}, JSON_OBJECT()),
              '$.aiGenerationRequestedAt'
            )`,
          })
          .where(eq(videos.id, videoId));
      }
    }

    // transcribeVideo refuses while the upload/processing is still running, and
    // it refuses SILENTLY (success:true, nothing launched). Answering
    // {started:true} here is what lost the owner's 2026-08-16 request: the
    // button reported success, transcriptionStatus stayed NULL, and nothing
    // ever picked the job up. Record the explicit request instead — the same
    // marker the PROCESSING branch above writes — so processVideoWorkflow
    // starts transcription the moment processing finishes (and the
    // recover-stale-ai-jobs cron picks it up if the app restarted meanwhile).
    //
    // Server-side JSON_SET for the same reason as above: a spread of the row
    // read at the top of this handler would revert whatever the upload /
    // processing workflow wrote in between (phase progress, duration, error
    // markers).
    //
    // `aiStartPendingUpload` is the ONE-SHOT start order both redeemers
    // consume (and JSON_REMOVE).
    //
    // `aiGenerationRequestedAt` is deliberately NOT written here (2026-09-05).
    // On a video with no transcript yet, this button IS the transcript button
    // — its own copy says so — so the press means "transcribe", not "run AI".
    // Writing the AI marker made the flag flip in process-video.ts /
    // recover-stale-ai-jobs a NO-OP: nothing ever clears the marker, and
    // shouldStartAiAfterTranscription ORs it back in
    // (ai-generation-request.ts:61), so the transcript still auto-chained into
    // a summary for the owner's most common flow — pressing while the upload
    // is still running. Leaving it unwritten also keeps the status poll
    // honest: `aiGenerationRequested` stays false, so the poll goes terminal
    // when the transcript lands instead of waiting forever for a handoff that
    // is not coming. The PROCESSING branch above still writes it, and should:
    // there the transcript is already underway, so a press there really does
    // mean "run the AI when it finishes".
    if (result.code === "UPLOAD_IN_PROGRESS") {
      const now = new Date().toISOString();
      // The press arrived before the upload finished: bank it as the ONE-SHOT
      // order carrying the CHOSEN MODE (2026-09-10), so both redeemers start
      // exactly what was pressed once the bytes land - transcript-only, or the
      // full chained run. 'full' also stamps the durable AI request: that run
      // really will chain into AI, and the status poll needs the marker to
      // keep watching for the transcript-to-QUEUED handoff. 'transcript' banks
      // NO AI request (and clears a stale one), so nothing downstream -
      // including the OR in shouldStartAiAfterTranscription - can re-enable
      // the auto-chain for it. An absent mode keeps whatever mode an earlier
      // press banked, defaulting to transcript-only.
      const bankedFull =
        startMode === "full" ||
        (startMode === null &&
          bankedStartRequestsFullAnalysis(existingMetadata));
      const bankedMode = bankedFull ? "full" : "transcript";
      await db()
        .update(videos)
        .set({
          metadata: bankedFull
            ? sql`JSON_SET(
                COALESCE(${videos.metadata}, JSON_OBJECT()),
                '$.aiGenerationRequestedAt', ${now},
                '$.aiGenerationRequestedBy', ${user.id},
                '$.aiJobStartedAt', COALESCE(
                  JSON_UNQUOTE(JSON_EXTRACT(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiJobStartedAt')),
                  ${now}
                ),
                '$.aiStartPendingUpload', ${now},
                '$.aiStartMode', ${bankedMode}
              )`
            : sql`JSON_REMOVE(
                JSON_SET(
                  COALESCE(${videos.metadata}, JSON_OBJECT()),
                  '$.aiGenerationRequestedBy', ${user.id},
                  '$.aiStartPendingUpload', ${now},
                  '$.aiStartMode', ${bankedMode}
                ),
                '$.aiGenerationRequestedAt'
              )`,
        })
        .where(eq(videos.id, videoId));

      return Response.json({
        queued: true,
        queuedAfterProcessing: true,
        message: result.message,
      });
    }

    return Response.json({ started: true });
  } catch (error) {
    console.error("[generate/route] Unexpected error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
