"use client";

import { Button } from "@cap/ui";
import { faUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { ChangeEvent } from "react";
import {
  IMPORT_FILE_ACCEPT,
  useImportUpload,
} from "@/app/(org)/dashboard/import/file/useImportUpload";
import { UpgradeModal } from "@/components/UpgradeModal";

export const UploadCapButton = ({
  size = "md",
  folderId,
}: {
  size?: "sm" | "lg" | "md";
  grey?: boolean;
  folderId?: string;
}) => {
  const t = useTranslations("library");
  const router = useRouter();
  // One-click fast path: clicking opens the OS file picker directly, and
  // picking a file starts the upload immediately into `folderId` (no
  // intermediate /dashboard/import screen, no PreUploadTrimmer step).
  //
  // We stay on the page rather than navigating — but staying still has to
  // REFRESH. The list is server-rendered, and the only revalidation in this
  // chain is `revalidatePath("/dashboard/folder")`, which does not match the
  // dynamic route `/dashboard/folder/[id]`. With a no-op callback the upload
  // finished, the progress placeholder vanished and the card never appeared,
  // so an empty folder said "empty" again and the user would re-upload the
  // same file believing it had failed. router.refresh() pulls the new props.
  const {
    inputRef,
    isUploading,
    upgradeModalOpen,
    setUpgradeModalOpen,
    processFile,
    processFiles,
    openFilePicker,
  } = useImportUpload({ folderId, onUploadStarted: () => router.refresh() });

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    // Copy the FileList BEFORE clearing the input: in a real browser
    // input.value = "" empties the LIVE FileList (length 2 -> 0), so reading
    // it after the clear saw an empty list and nothing ever uploaded.
    const files = Array.from(e.target.files ?? []);
    if (inputRef.current) inputRef.current.value = "";
    if (files.length === 0) return;
    // Multi-pick (owner order 2026-09-26): files upload one after another,
    // no trimmer. One file stays on today's direct path.
    if (files.length > 1) {
      void processFiles(files);
      return;
    }
    const file = files[0];
    if (!file) return;
    void processFile(file);
  };

  return (
    <>
      <Button
        onClick={openFilePicker}
        variant="dark"
        className="flex gap-2 items-center"
        size={size}
        disabled={isUploading}
      >
        <FontAwesomeIcon className="size-3.5" icon={faUpload} />
        {t("uploadVideo")}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={IMPORT_FILE_ACCEPT}
        multiple
        onChange={handleFileChange}
        className="hidden"
      />
      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
      />
    </>
  );
};
