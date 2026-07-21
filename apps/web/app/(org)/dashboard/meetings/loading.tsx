"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="flex flex-col min-h-screen lg:gap-5">
					{/* Content Area */}
					<div className="flex overflow-auto flex-col flex-1 bg-gray-2 lg:rounded-tl-2xl">
						<div className="flex flex-col gap-8 w-full">
							{/* Meetings are grouped by date ("Today", "This week", ...); render
							    two group skeletons so the grouped layout doesn't pop in late. */}
							{[10, 5].map((cardCount, groupIndex) => (
								<div
									key={groupIndex.toString()}
									className="flex flex-col gap-3 w-full"
								>
									{/* Group header (e.g. "Today") */}
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="!h-[13px] !w-[90px] !rounded"
									/>
									<div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
										{Array(cardCount)
											.fill(0)
											.map((_, index) => (
												<div
													key={index.toString()}
													className="flex relative flex-col gap-4 w-full h-full bg-gray-3 rounded-2xl border-gray-4 border-[1px]"
												>
													{/* Thumbnail */}
													<Skeleton
														baseColor="var(--gray-4)"
														highlightColor="var(--gray-5)"
														className="h-[150px] w-full aspect-video align-top !rounded-t-2xl !leading-none !rounded-b-none"
													/>
													<div className="px-4 pb-4">
														{/* Title */}
														<div className="flex flex-col gap-1">
															<Skeleton
																baseColor="var(--gray-4)"
																highlightColor="var(--gray-5)"
																className="h-[20px] w-full max-w-[180px]"
															/>
															<Skeleton
																baseColor="var(--gray-4)"
																highlightColor="var(--gray-5)"
																className="h-[16px] w-[80px]"
															/>
														</div>

														{/* Analytics */}
														<div className="flex flex-wrap gap-3 items-center mt-auto text-sm">
															{/* Views */}
															<div className="flex gap-1 items-center">
																<Skeleton
																	baseColor="var(--gray-4)"
																	highlightColor="var(--gray-5)"
																	circle
																	width={16}
																	height={16}
																/>
																<Skeleton
																	baseColor="var(--gray-4)"
																	highlightColor="var(--gray-5)"
																	width={20}
																	height={16}
																/>
															</div>

															{/* Comments */}
															<div className="flex gap-1 items-center">
																<Skeleton
																	baseColor="var(--gray-4)"
																	highlightColor="var(--gray-5)"
																	circle
																	width={16}
																	height={16}
																/>
																<Skeleton
																	baseColor="var(--gray-4)"
																	highlightColor="var(--gray-5)"
																	width={20}
																	height={16}
																/>
															</div>

															{/* Reactions */}
															<div className="flex gap-1 items-center">
																<Skeleton
																	baseColor="var(--gray-4)"
																	highlightColor="var(--gray-5)"
																	circle
																	width={16}
																	height={16}
																/>
																<Skeleton
																	baseColor="var(--gray-4)"
																	highlightColor="var(--gray-5)"
																	width={20}
																	height={16}
																/>
															</div>
														</div>
													</div>
												</div>
											))}
									</div>
								</div>
							))}
						</div>

						{/* Pagination */}
						<div className="flex justify-center mt-10">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[36px] w-[300px]"
							/>
						</div>
					</div>
				</div>
			)}
		/>
	);
}
