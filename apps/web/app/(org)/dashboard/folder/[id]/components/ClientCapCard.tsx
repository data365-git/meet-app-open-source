"use client";

import {
	CapCard,
	type CapCardProps,
} from "../../../caps/components/CapCard/CapCard";

type ClientCapCardProps = CapCardProps & {
	videoId: string;
	isLoadingAnalytics: boolean;
	analytics: number;
};

// Interface for drop targets that will be registered for mobile drag and drop
interface DropTarget {
	element: HTMLElement;
	onDrop: (data: any) => void;
	onDragOver?: () => void;
	onDragLeave?: () => void;
}

// Global registry for drop targets
let dropTargets: DropTarget[] = [];

// Register a drop target element
export function registerDropTarget(
	element: HTMLElement,
	onDrop: (data: any) => void,
	onDragOver?: () => void,
	onDragLeave?: () => void,
) {
	dropTargets.push({ element, onDrop, onDragOver, onDragLeave });
	return () => {
		dropTargets = dropTargets.filter((target) => target.element !== element);
	};
}

export function ClientCapCard(props: ClientCapCardProps) {
	const { isLoadingAnalytics, analytics, ...rest } = props;
	return (
		<CapCard
			{...rest}
			isLoadingAnalytics={isLoadingAnalytics}
			analytics={analytics}
		/>
	);
}
