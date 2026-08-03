"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { faFolderPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Effect, Exit } from "effect";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useVideosAnalyticsQuery } from "@/lib/Queries/Analytics";
import { useDashboardContext } from "../Contexts";
import type { VideoData } from "../caps/Caps";
import { NewFolderDialog, SelectedCapsBar } from "../caps/components";
import { CapCard } from "../caps/components/CapCard/CapCard";
import { CapPagination } from "../caps/components/CapPagination";
import Folder, { type FolderDataType } from "../caps/components/Folder";

type DateGroupKey = "groupToday" | "groupThisWeek" | "groupEarlier";

function getDateGroup(date: Date): DateGroupKey {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(
    startOfToday.getDate() - ((startOfToday.getDay() + 6) % 7),
  );

  if (date >= startOfToday) return "groupToday";
  if (date >= startOfWeek) return "groupThisWeek";
  return "groupEarlier";
}

export type MeetingVideoData = Omit<VideoData[number], "foldersData">;

export const Meetings = ({
  data,
  count,
  analyticsEnabled,
  folders,
}: {
  data: MeetingVideoData[];
  count: number;
  analyticsEnabled: boolean;
  folders: FolderDataType[];
}) => {
  const t = useTranslations("library");
  const router = useRouter();
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const { user } = useDashboardContext();
  const limit = 30;
  const totalPages = Math.ceil(count / limit);
  const bulkDeleteToastRef = useRef<string | number | undefined>(undefined);
  const [selectedCaps, setSelectedCaps] = useState<Video.VideoId[]>([]);
  const [openNewFolderDialog, setOpenNewFolderDialog] = useState(false);

  const anyCapSelected = selectedCaps.length > 0;

  const analyticsQuery = useVideosAnalyticsQuery(
    data.map((video) => video.id),
    analyticsEnabled,
  );
  const analytics: Partial<Record<Video.VideoId, number>> =
    analyticsQuery.data || {};
  const isLoadingAnalytics = analyticsEnabled && analyticsQuery.isLoading;

  const handleCapSelection = (capId: Video.VideoId) => {
    setSelectedCaps((prev) =>
      prev.includes(capId)
        ? prev.filter((id) => id !== capId)
        : [...prev, capId],
    );
  };

  const rpc = useRpcClient() as {
    VideoDelete: (id: Video.VideoId) => Effect.Effect<void, unknown, never>;
  };

  const { mutate: deleteCaps, isPending: isDeletingCaps } = useEffectMutation({
    mutationFn: Effect.fn(function* (ids: Video.VideoId[]) {
      if (ids.length === 0) return { success: 0 };

      const results = yield* Effect.all(
        ids.map((id) => rpc.VideoDelete(id).pipe(Effect.exit)),
        { concurrency: 10 },
      );

      const successCount = results.filter(Exit.isSuccess).length;
      const errorCount = ids.length - successCount;

      if (successCount > 0 && errorCount > 0) {
        return { success: successCount, error: errorCount };
      } else if (successCount > 0) {
        return { success: successCount };
      } else {
        return yield* Effect.fail(
          new Error(
            `Failed to delete ${errorCount} recording${errorCount === 1 ? "" : "s"}`,
          ),
        );
      }
    }),
    onMutate: (ids: Video.VideoId[]) => {
      bulkDeleteToastRef.current = toast.loading(
        `Deleting ${ids.length} recording${ids.length === 1 ? "" : "s"}...`,
      );
    },
    onSuccess: (result: { success: number; error?: number }) => {
      toast.dismiss(bulkDeleteToastRef.current);
      bulkDeleteToastRef.current = undefined;
      setSelectedCaps([]);
      router.refresh();
      if (result.error) {
        toast.success(
          `Successfully deleted ${result.success} recording${result.success === 1 ? "" : "s"}, but failed to delete ${result.error} recording${result.error === 1 ? "" : "s"}`,
        );
      } else {
        toast.success(
          `Successfully deleted ${result.success} recording${result.success === 1 ? "" : "s"}`,
        );
      }
    },
    onError: (error: unknown) => {
      toast.dismiss(bulkDeleteToastRef.current);
      bulkDeleteToastRef.current = undefined;
      const message =
        error instanceof Error
          ? error.message
          : "An error occurred while deleting recordings";
      toast.error(message);
    },
  });

  const { mutate: deleteCap, isPending: isDeletingCap } = useEffectMutation({
    mutationFn: Effect.fn(function* (id: Video.VideoId) {
      yield* rpc.VideoDelete(id);
    }),
    onSuccess: () => {
      toast.success("Recording deleted successfully");
      router.refresh();
    },
    onError: (_error: unknown) => toast.error("Failed to delete recording"),
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedCaps.length > 0) {
        setSelectedCaps([]);
      }

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedCaps.length > 0
      ) {
        if (e.key === "Backspace") {
          e.preventDefault();
        }

        if (
          !["INPUT", "TEXTAREA", "SELECT"].includes(
            document.activeElement?.tagName || "",
          )
        ) {
          deleteCaps(selectedCaps);
        }
      }

      if (e.key === "a" && (e.ctrlKey || e.metaKey) && data.length > 0) {
        if (
          !["INPUT", "TEXTAREA", "SELECT"].includes(
            document.activeElement?.tagName || "",
          )
        ) {
          e.preventDefault();
          setSelectedCaps(data.map((cap) => cap.id));
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedCaps, data, deleteCaps]);

  const isEmpty = count === 0 && folders.length === 0;
  const groupedVideos = useMemo(() => {
    return data.reduce(
      (groups, video) => {
        const group = getDateGroup(new Date(video.createdAt));
        groups[group].push(video);
        return groups;
      },
      {
        groupToday: [] as MeetingVideoData[],
        groupThisWeek: [] as MeetingVideoData[],
        groupEarlier: [] as MeetingVideoData[],
      },
    );
  }, [data]);

  return (
    <div className="flex relative flex-col w-full h-full">
      <NewFolderDialog
        open={openNewFolderDialog}
        onOpenChange={setOpenNewFolderDialog}
      />
      {!isEmpty && (
        <div className="flex flex-wrap gap-3 items-center mb-10 w-full">
          <Button
            size="sm"
            variant="white"
            className="flex gap-2 items-center w-fit"
            onClick={() => setOpenNewFolderDialog(true)}
          >
            <FontAwesomeIcon className="size-3" icon={faFolderPlus} />
            {t("newFolder")}
          </Button>
        </div>
      )}
      {folders.length > 0 && (
        <>
          <div className="flex gap-3 items-center mb-6 w-full">
            <h1 className="text-2xl font-medium text-gray-12">Folders</h1>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-10">
            {folders.map((folder) => (
              <Folder key={folder.id} {...folder} />
            ))}
          </div>
        </>
      )}
      {isEmpty && (
        <div className="flex flex-col flex-1 justify-center items-center w-full h-full">
          <div className="flex flex-col gap-3 justify-center items-center h-full text-center">
            <div className="flex flex-col items-center px-5">
              <p className="mb-1 text-[18px] font-bold text-gray-12">
                {t("meetingsEmptyTitle")}
              </p>
              <p className="max-w-[400px] text-[13.5px] text-gray-10">
                {t("meetingsEmptySubtitle")}
              </p>
            </div>
            <Link
              href="/dashboard/extension"
              className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-[var(--brand-fg)] transition-colors hover:brightness-95"
            >
              {t("installExtension")}
            </Link>
          </div>
        </div>
      )}
      {data.length > 0 && (
        <div className="flex flex-col gap-8">
          {(["groupToday", "groupThisWeek", "groupEarlier"] as const).map(
            (groupKey) => {
              const videos = groupedVideos[groupKey];
              if (videos.length === 0) return null;

              return (
                <section key={groupKey} className="flex flex-col gap-3">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-9">
                    {t(groupKey)}
                  </h2>
                  <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {videos.map((video) => {
                      const videoAnalytics = analytics[video.id];
                      return (
                        <CapCard
                          key={video.id}
                          cap={video}
                          analytics={videoAnalytics ?? 0}
                          onDelete={() => {
                            if (selectedCaps.length > 0) {
                              deleteCaps(selectedCaps);
                            } else {
                              deleteCap(video.id);
                            }
                          }}
                          userId={user?.id}
                          isLoadingAnalytics={isLoadingAnalytics}
                          isSelected={selectedCaps.includes(video.id)}
                          anyCapSelected={anyCapSelected}
                          onSelectToggle={() => handleCapSelection(video.id)}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            },
          )}
        </div>
      )}
      {(data.length > limit || data.length === limit || page !== 1) && (
        <div className="mt-7">
          <CapPagination currentPage={page} totalPages={totalPages} />
        </div>
      )}
      <SelectedCapsBar
        selectedCaps={selectedCaps}
        setSelectedCaps={setSelectedCaps}
        deleteSelectedCaps={() => deleteCaps(selectedCaps)}
        isDeleting={isDeletingCaps || isDeletingCap}
      />
    </div>
  );
};
