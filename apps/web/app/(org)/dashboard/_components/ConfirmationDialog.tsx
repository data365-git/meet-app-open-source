"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";

interface ConfirmationDialogProps {
	open: boolean;
	title?: string;
	// ReactNode, not string: a confirmation for an irreversible bulk action has
	// to be able to LIST what it is about to destroy, not just count it.
	description?: React.ReactNode;
	icon?: React.JSX.Element;
	confirmLabel?: string;
	cancelLabel?: string;
	confirmVariant?: "destructive" | "primary" | "dark" | "gray" | "outline";
	loading?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmationDialog({
	open,
	title = "Are you sure?",
	description,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	confirmVariant = "dark",
	loading = false,
	icon,
	onConfirm,
	onCancel,
}: ConfirmationDialogProps) {
	return (
		// While `loading` is true the action is already running and cannot be
		// called back. The Cancel BUTTON was always disabled then, but Escape and
		// an overlay click bypassed it and closed the dialog — on an irreversible
		// action that reads as "cancelled" while the videos are still being
		// destroyed. Dismissal is refused for as long as the action is in flight.
		<Dialog
			open={open}
			onOpenChange={(open) => {
				if (!open && !loading) onCancel();
			}}
		>
			<DialogContent className="p-0 w-[calc(100%-20px)] max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader icon={icon}>
					<DialogTitle className="text-lg text-gray-12">{title}</DialogTitle>
				</DialogHeader>
				<p className="p-5 text-[14px] leading-5 text-gray-11">{description}</p>
				<DialogFooter>
					<Button
						onClick={(e) => {
							e.stopPropagation();
							onCancel();
						}}
						variant="gray"
						size="sm"
						disabled={loading}
					>
						{cancelLabel}
					</Button>
					<Button
						onClick={(e) => {
							e.stopPropagation();
							onConfirm();
						}}
						variant={confirmVariant}
						size="sm"
						spinner={loading}
						disabled={loading}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
