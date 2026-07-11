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

function categoryOf(task: Task): (typeof TASK_CATEGORIES)[number] {
	return (TASK_CATEGORIES as readonly string[]).includes(task.category ?? "")
		? (task.category as (typeof TASK_CATEGORIES)[number])
		: "Boshqa";
}

function groupTasksByCategory(
	tasks: Task[],
): {
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

function priorityChipColors(priority?: "high" | "medium" | "low"): {
	background: string;
	color: string;
} {
	// amber/green Radix scales not imported in globals.css → fall back to neutral grays.
	if (priority === "high")
		return { background: "var(--red-3)", color: "var(--red-11)" };
	if (priority === "medium")
		return { background: "var(--gray-3)", color: "var(--gray-11)" };
	if (priority === "low")
		return { background: "var(--gray-3)", color: "var(--gray-11)" };
	return { background: "var(--gray-3)", color: "var(--gray-11)" };
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
			className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
			style={{ background: "var(--gray-4)", color: "var(--gray-12)" }}
			title={name}
		>
			{letters}
		</span>
	);
}

function DeadlinePill({ deadline }: { deadline: string }) {
	return (
		<span
			className="rounded-full px-2 py-0.5 text-[10px] font-medium"
			style={{ background: "var(--gray-2)", color: "var(--gray-11)" }}
		>
			{deadline}
		</span>
	);
}

function PriorityBadge({ priority }: { priority?: "high" | "medium" | "low" }) {
	if (!priority) return null;
	const { background, color } = priorityChipColors(priority);
	return (
		<span
			className="rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
			style={{ background, color }}
		>
			{priority}
		</span>
	);
}

function ProgressBar({ done, total }: { done: number; total: number }) {
	const pct = total === 0 ? 0 : Math.round((done / total) * 100);
	return (
		<div className="flex items-center gap-3">
			<div
				className="relative flex-1 overflow-hidden rounded-full"
				style={{ height: "6px", background: "var(--gray-3)" }}
			>
				<div
					className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
					style={{
						width: `${pct}%`,
						background: "var(--brand)",
					}}
				/>
			</div>
			<span
				className="w-10 shrink-0 text-right text-xs font-semibold"
				style={{ color: "var(--brand)", fontVariantNumeric: "tabular-nums" }}
			>
				{pct}%
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
				toast.error(t("videoTitleUpdateFailed"));
			}
		} catch (error) {
			console.error("Failed to update task status:", error);
			setTasks((prev) =>
				prev.map((t, i) => (i === index ? { ...t, done: task.done } : t)),
			);
			toast.error(t("videoTitleUpdateFailed"));
		}
	}

	if (total === 0) {
		return <p className="text-sm text-gray-11">{t("noActionItems")}</p>;
	}

	return (
		<div className="flex flex-col gap-3">
			<ProgressBar done={done} total={total} />
			<div className="flex flex-col gap-4">
				{groupTasksByCategory(tasks).map(({ category, items }) => (
					<div key={category} className="flex flex-col">
						<h4
							className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide"
							style={{ color: "var(--gray-10)" }}
						>
							{category}
						</h4>
						{items.map(({ task, index }, i) => (
							<div
								key={`task-${index}`}
								className="flex items-center gap-3"
								style={{
									minHeight: "38px",
									padding: "8px 4px",
									borderBottom:
										i === items.length - 1 ? "none" : "1px solid var(--gray-3)",
								}}
							>
								<input
									type="checkbox"
									checked={task.done}
									onChange={() => toggle(index)}
									disabled={!canEdit}
									className={`size-4 shrink-0 ${canEdit ? "cursor-pointer" : "cursor-default"} accent-[var(--brand)]`}
								/>
								<span
									className="flex-1 text-sm"
									style={{
										color: task.done ? "var(--gray-10)" : "var(--gray-12)",
										textDecoration: task.done ? "line-through" : "none",
									}}
								>
									{task.title}
								</span>
								<PriorityBadge priority={task.priority} />
								{task.assignee && <Initials name={task.assignee} />}
								{task.deadline && <DeadlinePill deadline={task.deadline} />}
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
