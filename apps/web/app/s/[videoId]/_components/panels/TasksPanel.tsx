"use client";

import type { Video } from "@cap/web-domain";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { updateTaskStatus } from "@/actions/videos/update-task-status";

interface Task {
	title: string;
	assignee?: string;
	priority?: "high" | "medium" | "low";
	deadline?: string;
	done: boolean;
	category?: string;
}

// Stable render order for category sections (T8). Legacy tasks (generated
// before this field existed) and anything outside this controlled vocab fall
// into "Boshqa" so the grouping never drops a task.
const TASK_CATEGORIES = [
	"Sotuv",
	"Marketing",
	"Moliya",
	"Texnik",
	"HR",
	"Operatsion",
	"Strategiya",
	"Boshqa",
] as const;

const TASK_CATEGORY_KEYS = {
	Sotuv: "taskCategorySales",
	Marketing: "taskCategoryMarketing",
	Moliya: "taskCategoryFinance",
	Texnik: "taskCategoryTechnical",
	HR: "taskCategoryHr",
	Operatsion: "taskCategoryOperations",
	Strategiya: "taskCategoryStrategy",
	Boshqa: "taskCategoryOther",
} as const;

function categoryOf(task: Task): (typeof TASK_CATEGORIES)[number] {
	return (TASK_CATEGORIES as readonly string[]).includes(task.category ?? "")
		? (task.category as (typeof TASK_CATEGORIES)[number])
		: "Boshqa";
}

function groupTasksByCategory(tasks: Task[]): {
	category: (typeof TASK_CATEGORIES)[number];
	items: { task: Task; index: number }[];
}[] {
	const groups = new Map<string, { task: Task; index: number }[]>();
	tasks.forEach((task, index) => {
		const category = categoryOf(task);
		const items = groups.get(category);
		if (items) items.push({ task, index });
		else groups.set(category, [{ task, index }]);
	});
	return TASK_CATEGORIES.filter((category) => groups.has(category)).map(
		(category) => ({ category, items: groups.get(category) ?? [] }),
	);
}

interface TasksPanelProps {
	videoId: string;
	tasks?: Task[];
	canEdit?: boolean;
}

function Initials({ name }: { name: string }) {
	const parts = name.trim().split(/\s+/);
	const letters =
		parts.length >= 2
			? (
					(parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")
				).toUpperCase()
			: name.slice(0, 2).toUpperCase();
	return (
		<span
			className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--brand-wash)] text-[9px] font-semibold text-[var(--brand)]"
			title={name}
		>
			{letters}
		</span>
	);
}

function DeadlinePill({ deadline }: { deadline: string }) {
	return (
		<span className="whitespace-nowrap rounded-full bg-[var(--brand-wash)] px-2 py-0.5 text-[11px] font-medium text-[var(--brand)]">
			{deadline}
		</span>
	);
}

function PriorityDot({
	priority,
	label,
}: {
	priority?: "high" | "medium" | "low";
	label?: string;
}) {
	if (!priority) return null;
	const color =
		priority === "high"
			? "bg-[var(--ds-error)]"
			: priority === "medium"
				? "bg-[var(--ds-warning)]"
				: "bg-gray-7";
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			className={`mt-1.5 size-2 shrink-0 rounded-full ${color}`}
		/>
	);
}

function ProgressBar({
	done,
	total,
	label,
}: {
	done: number;
	total: number;
	label: string;
}) {
	const pct = total === 0 ? 0 : Math.round((done / total) * 100);
	return (
		<div className="flex items-center gap-3">
			<div className="relative h-1 flex-1 overflow-hidden rounded-full bg-gray-4">
				<div
					className="absolute inset-y-0 left-0 rounded-full bg-[var(--brand)] transition-[width] duration-300 motion-reduce:transition-none"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span className="shrink-0 whitespace-nowrap font-mono text-[11.5px] text-gray-10">
				{label}
			</span>
		</div>
	);
}

export function TasksPanel({
	videoId,
	tasks: initialTasks = [],
	canEdit = false,
}: TasksPanelProps) {
	const t = useTranslations("share");
	const [tasks, setTasks] = useState<Task[]>(initialTasks);

	useEffect(() => {
		setTasks(initialTasks);
	}, [initialTasks]);

	const done = tasks.filter((t) => t.done).length;
	const total = tasks.length;
	const priorityLabels = {
		high: t("taskPriorityHigh"),
		medium: t("taskPriorityMedium"),
		low: t("taskPriorityLow"),
	};

	async function toggle(index: number) {
		if (!canEdit) return;
		const task = tasks[index];
		if (!task) return;
		const newDone = !task.done;
		setTasks((prev) =>
			prev.map((t, i) => (i === index ? { ...t, done: newDone } : t)),
		);
		try {
			const result = await updateTaskStatus(
				videoId as Video.VideoId,
				index,
				newDone,
			);
			if (!result.success) {
				setTasks((prev) =>
					prev.map((t, i) => (i === index ? { ...t, done: task.done } : t)),
				);
				toast.error(t("taskUpdateFailed"));
			}
		} catch (error) {
			console.error("Failed to update task status:", error);
			setTasks((prev) =>
				prev.map((t, i) => (i === index ? { ...t, done: task.done } : t)),
			);
			toast.error(t("taskUpdateFailed"));
		}
	}

	if (total === 0) {
		return <p className="text-sm text-gray-11">{t("noActionItems")}</p>;
	}

	return (
		<div className="flex flex-col gap-4">
			<ProgressBar
				done={done}
				total={total}
				label={t("taskProgress", { done, total })}
			/>
			<div className="flex flex-col gap-5">
				{groupTasksByCategory(tasks).map(({ category, items }) => (
					<section key={category} className="flex min-w-0 flex-col">
						<h4 className="px-1 pb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-10">
							{t(TASK_CATEGORY_KEYS[category])}
						</h4>
						{items.map(({ task, index }) => (
							<div
								key={task.title + index}
								className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b border-gray-4 px-1 py-3 last:border-b-0"
							>
								<label
									className={[
										"-my-3 -ml-3 flex size-11 items-center justify-center",
										canEdit ? "cursor-pointer" : "cursor-default",
									].join(" ")}
								>
									<input
										type="checkbox"
										checked={task.done}
										onChange={() => toggle(index)}
										disabled={!canEdit}
										aria-label={task.title}
										className="peer sr-only"
									/>
									<span
										className={[
											"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
											task.done
												? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
												: "border-gray-7 bg-gray-1 text-transparent",
											canEdit
												? "cursor-pointer hover:border-[var(--brand)]"
												: "cursor-default opacity-70",
											"peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--brand)]",
										].join(" ")}
									>
										<svg
											width="11"
											height="11"
											viewBox="0 0 12 12"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
											aria-hidden="true"
										>
											<path d="m2.5 6 2.1 2.1L9.5 3.5" />
										</svg>
									</span>
								</label>
								<div className="min-w-0">
									<p
										className={[
											"break-words text-[13.5px] font-medium leading-snug",
											task.done ? "text-gray-10 line-through" : "text-gray-12",
										].join(" ")}
									>
										{task.title}
									</p>
									{(task.assignee || task.deadline) && (
										<div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
											{task.assignee && (
												<>
													<Initials name={task.assignee} />
													<span className="max-w-full truncate text-[11px] text-gray-10">
														{task.assignee}
													</span>
												</>
											)}
											{task.deadline && (
												<DeadlinePill deadline={task.deadline} />
											)}
										</div>
									)}
								</div>
								<PriorityDot
									priority={task.priority}
									label={
										task.priority ? priorityLabels[task.priority] : undefined
									}
								/>
							</div>
						))}
					</section>
				))}
			</div>
		</div>
	);
}
