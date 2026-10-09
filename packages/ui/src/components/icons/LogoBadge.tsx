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
				d="M49 38.6V26.8C49 21.2 44.8 17 39.2 17H24.8C19.2 17 15 21.2 15 26.8v10.6C15 43 19.2 47 24.8 47H39"
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
			<circle cx="47" cy="47" r="4" fill="#35efc2" />
		</svg>
	);
};
