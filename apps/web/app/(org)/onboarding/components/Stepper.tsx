"use client";

import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Fragment } from "react";

export default function Stepper({
	completedSteps,
}: {
	completedSteps: {
		welcome?: boolean;
		organizationSetup?: boolean;
		customDomain?: boolean;
		download?: boolean;
	};
}) {
	const t = useTranslations("onboarding");
	const currentPath = usePathname();

	// NOTE: the highlight/active-step lookup below compares by `path` (a stable,
	// untranslated route string), never by the translated `name`. currentPath and
	// step.path are both derived independently of t(), so there is no risk of the
	// active-step highlight silently breaking if the translated label changes.
	const steps = [
		{
			id: "1",
			path: "/onboarding/welcome",
			name: t("stepWelcome"),
			completed: completedSteps.welcome || false,
		},
		{
			id: "2",
			path: "/onboarding/organization-setup",
			name: t("stepOrganization"),
			completed: completedSteps.organizationSetup || false,
		},
		{
			id: "3",
			path: "/onboarding/custom-domain",
			name: t("stepCustomDomain"),
			completed: completedSteps.customDomain || false,
		},
		{
			id: "4",
			path: "/onboarding/download",
			name: t("stepDownload"),
			completed: completedSteps.download || false,
		},
	];

	const activeStep = steps.find((step) => step.path === currentPath);

	return (
		<>
			{/* Mobile Stepper - shows on devices up to 1024px */}
			<div className="justify-center mx-auto mb-10 max-w-fit lg:hidden">
				<MobileStepper
					activeStep={activeStep}
					totalSteps={steps.length}
					stepLabel={t("stepLabel")}
				/>
			</div>

			{/* Desktop Stepper - shows on devices 1024px and up */}
			<div className="hidden absolute right-0 left-0 top-6 justify-center items-center p-4 mx-auto rounded-xl border lg:flex max-w-fit bg-gray-2 border-gray-4">
				{steps.map((step, idx) => {
					return (
						<Fragment key={step.id}>
							<div className="flex justify-center items-center">
								{idx !== 0 && (
									<div className="flex-1 mx-5 border-t border-dashed min-w-[72px] h-[2px] border-gray-8" />
								)}
								<div className="flex flex-1 gap-2 justify-center items-center min-w-fit">
									<div
										className={clsx(
											"flex justify-center items-center text-xs text-white rounded-full size-5 min-size-5",
											step.path === currentPath && !step.completed
												? "bg-blue-500"
												: step.completed
													? "bg-green-500"
													: "bg-gray-7",
										)}
									>
										{step.completed ? (
											<FontAwesomeIcon
												icon={faCheck}
												className="text-white size-2"
											/>
										) : (
											<p>{step.id}</p>
										)}
									</div>
									<p
										className={clsx(
											"text-[13px] text-nowrap",
											step.completed || step.path === currentPath
												? "text-gray-12"
												: "text-gray-9",
										)}
									>
										{step.name}
									</p>
								</div>
							</div>
						</Fragment>
					);
				})}
			</div>
		</>
	);
}

const MobileStepper = ({
	activeStep,
	totalSteps,
	stepLabel,
}: {
	activeStep:
		| {
				id: string;
				name: string;
				completed: boolean;
		  }
		| undefined;
	totalSteps: number;
	stepLabel: string;
}) => {
	if (!activeStep) return null;

	return (
		<div className="flex gap-x-4 items-center p-3 rounded-xl border bg-gray-2 border-gray-4">
			<div className="flex gap-2 items-center">
				<div
					className={clsx(
						"flex justify-center items-center text-xs text-white rounded-full size-5 min-size-5",
						"bg-blue-500",
					)}
				>
					<p>{activeStep.id}</p>
				</div>
				<p className="text-sm font-medium text-gray-12">{activeStep.name}</p>
			</div>
			<div>
				<p className="text-[13px] text-gray-10">
					{stepLabel}{" "}
					<span className="text-gray-11">
						{activeStep.id}/{totalSteps}
					</span>
				</p>
			</div>
		</div>
	);
};
