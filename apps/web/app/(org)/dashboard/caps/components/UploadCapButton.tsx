"use client";

import { Button } from "@cap/ui";
import { faUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useTranslations } from "next-intl";
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
  // One-click fast path: clicking opens the OS file picker directly, and
  // picking a file starts the upload immediately into `folderId` (no
  // intermediate /dashboard/import screen, no PreUploadTrimmer step).
  // Staying put (onUploadStarted: no-op) mirrors the Caps page's own
  // one-step import, which shows an <UploadPlaceholderCard/> in place.
  const {
    inputRef,
    isUploading,
    upgradeModalOpen,
    setUpgradeModalOpen,
    processFile,
    openFilePicker,
  } = useImportUpload({ folderId, onUploadStarted: () => {} });

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = "";
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
