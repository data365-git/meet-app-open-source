import { useCallback, useRef } from "react";
import {
	appendLocalRecordingChunk,
	finalizeLocalRecording,
	type LocalRecordingStrategy,
} from "./local-recording-backup";
import type { RecorderErrorEvent } from "./web-recorder-types";

export const useMediaRecorderSetup = () => {
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const recordedChunksRef = useRef<Blob[]>([]);
	const totalRecordedBytesRef = useRef(0);
	const localRecordingStrategyRef = useRef<LocalRecordingStrategy>({
		mode: "full",
	});
	const retainedRecordingBytesRef = useRef(0);
	const localRecordingOverflowedRef = useRef(false);
	const stopPromiseResolverRef = useRef<((blob: Blob | null) => void) | null>(
		null,
	);
	const stopPromiseRejectRef = useRef<((reason?: unknown) => void) | null>(
		null,
	);
	const isStoppingRef = useRef(false);
	// Set only when onRecorderError arms a stop promise ahead of the
	// recorder's own auto-stop (see onRecorderError below). Lets a concurrent
	// stopRecordingInternal call hand back the same pending promise instead of
	// racing a second recorder.stop().
	const armedStopPromiseRef = useRef<Promise<Blob | null> | null>(null);

	const setLocalRecordingStrategy = useCallback(
		(strategy: LocalRecordingStrategy) => {
			localRecordingStrategyRef.current = strategy;
			recordedChunksRef.current = [];
			retainedRecordingBytesRef.current = 0;
			localRecordingOverflowedRef.current = false;
		},
		[],
	);

	const replaceLocalRecording = useCallback(
		(chunks: Blob[], strategy: LocalRecordingStrategy) => {
			localRecordingStrategyRef.current = strategy;
			recordedChunksRef.current = chunks.filter((chunk) => chunk.size > 0);
			retainedRecordingBytesRef.current = recordedChunksRef.current.reduce(
				(total, chunk) => total + chunk.size,
				0,
			);
			localRecordingOverflowedRef.current = false;
		},
		[],
	);

	const appendToLocalRecording = useCallback((chunk: Blob) => {
		if (chunk.size === 0) {
			return;
		}

		const nextState = appendLocalRecordingChunk(
			{
				chunks: recordedChunksRef.current,
				retainedBytes: retainedRecordingBytesRef.current,
				overflowed: localRecordingOverflowedRef.current,
			},
			chunk,
			{ mode: "full" },
		);
		recordedChunksRef.current = nextState.chunks;
		retainedRecordingBytesRef.current = nextState.retainedBytes;
		localRecordingOverflowedRef.current = nextState.overflowed;
	}, []);

	const onRecorderDataAvailable = useCallback(
		(event: BlobEvent, onChunk?: (chunk: Blob, totalBytes: number) => void) => {
			if (event.data && event.data.size > 0) {
				totalRecordedBytesRef.current += event.data.size;
				const nextState = appendLocalRecordingChunk(
					{
						chunks: recordedChunksRef.current,
						retainedBytes: retainedRecordingBytesRef.current,
						overflowed: localRecordingOverflowedRef.current,
					},
					event.data,
					localRecordingStrategyRef.current,
				);
				recordedChunksRef.current = nextState.chunks;
				retainedRecordingBytesRef.current = nextState.retainedBytes;
				localRecordingOverflowedRef.current = nextState.overflowed;
				onChunk?.(event.data, totalRecordedBytesRef.current);
			}
		},
		[],
	);

	const onRecorderStop = useCallback(() => {
		const blob = finalizeLocalRecording({
			chunks: recordedChunksRef.current,
			retainedBytes: retainedRecordingBytesRef.current,
			overflowed: localRecordingOverflowedRef.current,
		});

		if (!blob && localRecordingStrategyRef.current.mode === "full") {
			const rejecter = stopPromiseRejectRef.current;
			stopPromiseResolverRef.current = null;
			stopPromiseRejectRef.current = null;
			armedStopPromiseRef.current = null;
			isStoppingRef.current = false;
			rejecter?.(new Error("No recorded data"));
			return;
		}

		recordedChunksRef.current = [];
		retainedRecordingBytesRef.current = 0;
		localRecordingOverflowedRef.current = false;
		const resolver = stopPromiseResolverRef.current;
		stopPromiseResolverRef.current = null;
		stopPromiseRejectRef.current = null;
		armedStopPromiseRef.current = null;
		isStoppingRef.current = false;
		resolver?.(blob);
	}, []);

	const onRecorderError = useCallback(
		(event: RecorderErrorEvent, onUnexpectedError?: (error: Error) => void) => {
			const error = event.error ?? new DOMException("Recording error");

			if (isStoppingRef.current) {
				const rejecter = stopPromiseRejectRef.current;
				stopPromiseResolverRef.current = null;
				stopPromiseRejectRef.current = null;
				armedStopPromiseRef.current = null;
				isStoppingRef.current = false;
				rejecter?.(error);
				return;
			}

			// No stop was requested: this is a fatal error mid-recording. Per
			// the MediaRecorder spec the browser fires `stop` right after this
			// handler returns (still synchronously, before onRecorderStop
			// would otherwise see no resolver and discard the buffered
			// bytes). Arm the stop promise now — without calling
			// recorder.stop() ourselves, since the browser is already
			// stopping it — so the caller can await the real, finalized blob
			// and salvage it instead of losing it.
			isStoppingRef.current = true;
			const stopPromise = new Promise<Blob | null>((resolve, reject) => {
				stopPromiseResolverRef.current = resolve;
				stopPromiseRejectRef.current = reject;
			});
			armedStopPromiseRef.current = stopPromise;

			onUnexpectedError?.(error);
		},
		[],
	);

	const stopRecordingInternal = useCallback(
		async (cleanupStreams: () => void, clearTimer: () => void) => {
			if (isStoppingRef.current) {
				// A stop is already armed — e.g. onRecorderError armed one
				// ahead of the recorder's own imminent auto-stop. Hand back
				// the same pending promise instead of racing a second
				// recorder.stop() call.
				return armedStopPromiseRef.current;
			}

			const recorder = mediaRecorderRef.current;
			if (!recorder || recorder.state === "inactive") return null;

			isStoppingRef.current = true;

			const stopPromise = new Promise<Blob | null>((resolve, reject) => {
				stopPromiseResolverRef.current = resolve;
				stopPromiseRejectRef.current = reject;
			});
			armedStopPromiseRef.current = stopPromise;

			recorder.stop();
			cleanupStreams();
			clearTimer();

			return stopPromise;
		},
		[],
	);

	const resetRecorder = useCallback(() => {
		mediaRecorderRef.current = null;
		recordedChunksRef.current = [];
		totalRecordedBytesRef.current = 0;
		localRecordingStrategyRef.current = { mode: "full" };
		retainedRecordingBytesRef.current = 0;
		localRecordingOverflowedRef.current = false;
	}, []);

	return {
		mediaRecorderRef,
		recordedChunksRef,
		totalRecordedBytesRef,
		setLocalRecordingStrategy,
		replaceLocalRecording,
		appendToLocalRecording,
		onRecorderDataAvailable,
		onRecorderStop,
		onRecorderError,
		stopRecordingInternal,
		resetRecorder,
	};
};
