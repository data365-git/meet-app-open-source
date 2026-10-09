import { Videos } from "@cap/web-backend";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { apiToHandler } from "@/lib/server";

// Irreversible erase, for the recorder's "permanently discard". This is
// deliberately a SEPARATE route from /api/video/delete: that one soft-deletes
// into the 3-day Trash (owner-shortened from 7 on 2026-09-11), which is a
// wanted feature and must keep working.
//
// There is no NotFound error here on purpose — an already-erased video is the
// state the caller asked for, so `permanentlyDelete` succeeds quietly and this
// route returns 2xx. That makes the endpoint safe for a client to retry.
class Api extends HttpApi.make("Api").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.del("deleteVideoPermanently")`/api/video/delete-permanent`
			.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			Effect.gen(function* () {
				const videos = yield* Videos;

				return handlers.handle("deleteVideoPermanently", ({ urlParams }) =>
					videos.permanentlyDelete(urlParams.videoId).pipe(
						Effect.catchTags({
							PolicyDenied: () => new HttpApiError.Forbidden(),
							DatabaseError: (e) =>
								Effect.logError(e).pipe(
									Effect.andThen(() => new HttpApiError.InternalServerError()),
								),
							StorageError: (e) =>
								Effect.logError(e).pipe(
									Effect.andThen(() => new HttpApiError.InternalServerError()),
								),
						}),
					),
				);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const DELETE = handler;
