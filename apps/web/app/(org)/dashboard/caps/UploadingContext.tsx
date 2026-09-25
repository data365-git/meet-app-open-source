"use client";

import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

export type UploadStatus =
	| {
			status: "parsing";
	  }
	| {
			status: "creating";
	  }
	| {
			status: "converting";
			capId: string;
			progress: number;
			loadedBytes?: number;
			totalBytes?: number;
			bytesPerSecond?: number;
			secondsRemaining?: number;
	  }
	| {
			status: "uploadingThumbnail";
			capId: string;
			progress: number;
			loadedBytes?: number;
			totalBytes?: number;
			bytesPerSecond?: number;
			secondsRemaining?: number;
	  }
	| {
			status: "uploadingVideo";
			capId: string;
			progress: number;
			thumbnailUrl: string | undefined;
			loadedBytes?: number;
			totalBytes?: number;
			bytesPerSecond?: number;
			secondsRemaining?: number;
	  }
	| {
			status: "serverProcessing";
			capId: string;
	  };

interface UploadingStoreState {
	uploadStatus?: UploadStatus;
	/** Owner order 2026-09-11: a Cancel control on an in-progress upload. Set
	 *  by useImportUpload for the duration of one upload attempt, cleared in
	 *  every terminal path (success, failure, or cancel itself) — undefined
	 *  means there is nothing cancellable right now, whatever uploadStatus
	 *  says (e.g. once server processing has genuinely started). */
	cancelHandler?: () => void;
}

interface UploadingContextType {
	uploadingStore: Store<UploadingStoreState>;
	setUploadStatus: (state: UploadStatus | undefined) => void;
	setCancelHandler: (handler: (() => void) | undefined) => void;
}

const UploadingContext = createContext<UploadingContextType | undefined>(
	undefined,
);

export function useUploadingContext() {
	const context = useContext(UploadingContext);
	if (!context)
		throw new Error(
			"useUploadingContext must be used within an UploadingProvider",
		);
	return context;
}

export function useUploadingStatus() {
	const { uploadingStore } = useUploadingContext();
	return useStore(
		uploadingStore,
		(s) =>
			[
				s.uploadStatus !== undefined,
				s.uploadStatus && "capId" in s.uploadStatus
					? s.uploadStatus.capId
					: null,
			] as const,
	);
}

export function UploadingProvider({ children }: { children: React.ReactNode }) {
	const [uploadingStore] = useState<Store<UploadingStoreState>>(
		() => new Store({}),
	);

	return (
		<UploadingContext.Provider
			value={{
				uploadingStore,
				setUploadStatus: (status: UploadStatus | undefined) => {
					uploadingStore.setState((state) => ({
						...state,
						uploadStatus: status,
					}));
				},
				setCancelHandler: (handler: (() => void) | undefined) => {
					uploadingStore.setState((state) => ({
						...state,
						cancelHandler: handler,
					}));
				},
			}}
		>
			{children}

			<ForbidLeaveWhenUploading />
		</UploadingContext.Provider>
	);
}

// Separated to prevent rerendering whole tree
function ForbidLeaveWhenUploading() {
	const { uploadingStore } = useUploadingContext();
	const uploadStatus = useStore(uploadingStore, (state) => state.uploadStatus);

	useEffect(() => {
		const handleBeforeUnload = (e: BeforeUnloadEvent) => {
			if (uploadStatus?.status) {
				e.preventDefault();
				// Chrome requires returnValue to be set
				e.returnValue = "";
				return "";
			}
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [uploadStatus]);

	return null;
}
