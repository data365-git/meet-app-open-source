"use client";

import { Button } from "@cap/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { startTransition, useState } from "react";
import { toast } from "sonner";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { Base } from "./Base";

export function CustomDomainPage() {
	const t = useTranslations("onboarding");
	const router = useRouter();
	const rpc = useRpcClient();
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);

	const customDomainMutation = useEffectMutation({
		mutationFn: (_redirect: boolean) =>
			rpc.UserCompleteOnboardingStep({
				step: "customDomain",
				data: undefined,
			}),
		onSuccess: (_, redirect) => {
			startTransition(() => {
				if (redirect) {
					router.push("/onboarding/download");
					router.refresh();
				}
			});
		},
		onError: () => {
			toast.error(t("errorGeneric"));
		},
	});

	const handleSubmit = async (redirect = true) =>
		await customDomainMutation.mutateAsync(redirect);

	return (
		<Base
			title={t("customDomainTitle")}
			description={
				<div>
					<p className="w-full text-base max-w-[340px] text-gray-10">
						{t.rich("customDomainDescription", {
							domain: (chunks) => (
								<span className="font-medium text-blue-500">{chunks}</span>
							),
						})}
					</p>
				</div>
			}
			descriptionClassName="max-w-[400px]"
		>
			<Button
				onClick={() => setShowUpgradeModal(true)}
				className="w-full"
				disabled={customDomainMutation.isPending}
				variant="blue"
			>
				{t("upgradeToPro")}
			</Button>
			<div className="w-full h-px bg-gray-4" />
			<Button
				type="button"
				variant="transparent"
				spinner={customDomainMutation.isPending}
				disabled={customDomainMutation.isPending}
				className="mx-auto w-full"
				onClick={() => handleSubmit()}
			>
				{t("skip")}
			</Button>
			<UpgradeModal
				onCheckout={async () => {
					await handleSubmit();
				}}
				onboarding={true}
				open={showUpgradeModal}
				onOpenChange={setShowUpgradeModal}
			/>
		</Base>
	);
}
