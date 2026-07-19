"use client";

import { Folder } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { WebRecorderDialog } from "../components/web-recorder-dialog/web-recorder-dialog";

export const RecordVideoPage = ({ folderId }: { folderId?: string }) => {
	const router = useRouter();

	return (
		<div
			className="flex flex-col flex-1 justify-center items-center w-full h-full"
			style={{ scrollbarGutter: "stable" }}
		>
			<div className="w-full flex flex-col gap-3 justify-center items-center h-full text-center">
				<div className="w-full px-5">
					<div className="mx-auto w-full max-w-[560px] min-w-0">
						<div className="flex flex-col items-center">
							<p className="max-w-md text-gray-10 text-md">
								Record your screen right in your browser
							</p>
						</div>
						<div className="flex flex-wrap gap-3 justify-center items-center mt-4">
							<WebRecorderDialog
								folderId={folderId ? Folder.FolderId.make(folderId) : undefined}
								defaultOpen
								onClose={() => router.push("/dashboard/caps")}
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
