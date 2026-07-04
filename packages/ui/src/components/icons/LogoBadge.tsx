import { useId } from "react";

export const LogoBadge = ({ className }: { className: string }) => {
	const id = useId();
	const badgeFillId = `${id}-data365-blue-badge`;

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			fill="none"
			viewBox="0 0 64 64"
			preserveAspectRatio="xMidYMid meet"
			role="img"
			aria-label="data365"
			style={{
				aspectRatio: "1 / 1",
			}}
		>
			<defs>
				<linearGradient
					id={badgeFillId}
					x1="8"
					y1="6"
					x2="56"
					y2="58"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#1d7cff" />
					<stop offset="1" stopColor="#005bea" />
				</linearGradient>
			</defs>
			<rect width="64" height="64" rx="16" fill={`url(#${badgeFillId})`} />
			<path
				d="M50 39.5V26.5C50 20.7 45.3 16 39.5 16h-15C18.7 16 14 20.7 14 26.5v11C14 43.3 18.7 48 24.5 48H40"
				stroke="white"
				strokeWidth="5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M28 25.2v13.6c0 1.2 1.3 1.9 2.3 1.3l11-6.8c1-.6 1-2 0-2.6l-11-6.8c-1-.6-2.3.1-2.3 1.3Z"
				fill="white"
				strokeLinejoin="round"
			/>
			<circle cx="48" cy="48" r="4.2" fill="#35efc2" />
		</svg>
	);
};
