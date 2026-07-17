import { parseVideoIdOrFileKey } from "../utils";

export const getSubpath = (input: { subpath?: string; fileKey?: string }) => {
	if ("fileKey" in input) {
		return undefined;
	}

	return input.subpath ?? "result.mp4";
};

export const getMultipartFileKey = (
	userId: string,
	input:
		| { videoId?: string; subpath?: string }
		| {
				fileKey?: string;
		  },
) => {
	if ("fileKey" in input && input.fileKey) {
		return parseVideoIdOrFileKey(userId, { fileKey: input.fileKey });
	}

	if (!("videoId" in input) || !input.videoId) {
		throw new Error("Video id not found");
	}

	return parseVideoIdOrFileKey(userId, {
		videoId: input.videoId,
		subpath: input.subpath ?? "result.mp4",
	});
};

export const isRawRecorderUpload = (subpath: string) =>
	subpath.startsWith("raw-upload.");

// Defence-in-depth for the /complete route: a gapped part list (e.g. produced
// by a mis-built client retry path) must never reach S3's completeMultipart,
// which either fails or assembles a corrupt object.
export const isSequentialPartList = (parts: { partNumber: number }[]) => {
	const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
	return sorted.every((part, index) => part.partNumber === index + 1);
};
