import { useId } from "react";

export const LogoBadge = ({ className }: { className: string }) => {
	const id = useId();
	const badgeFillId = `${id}-data365-badge-fill`;
	const playFillId = `${id}-data365-play-fill`;
	const orbitStrokeId = `${id}-data365-orbit-stroke`;

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
					x1="14"
					y1="9"
					x2="50"
					y2="55"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#f8fbff" />
					<stop offset="1" stopColor="#eaf4ff" />
				</linearGradient>
				<linearGradient
					id={playFillId}
					x1="18"
					y1="21"
					x2="40"
					y2="43"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#25d0c3" />
					<stop offset="1" stopColor="#2478ff" />
				</linearGradient>
				<linearGradient
					id={orbitStrokeId}
					x1="18"
					y1="15"
					x2="50"
					y2="34"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#2dd4bf" />
					<stop offset="1" stopColor="#1d4ed8" />
				</linearGradient>
			</defs>
			<rect
				x="4"
				y="4"
				width="56"
				height="56"
				rx="16"
				fill={`url(#${badgeFillId})`}
			/>
			<rect x="4.5" y="4.5" width="55" height="55" rx="15.5" stroke="#dbeafe" />
			<path
				d="M23 17.5c6.7-4.6 16.2-3.5 21.7 2.5 2.5 2.7 3.9 6 4.1 9.4"
				stroke={`url(#${orbitStrokeId})`}
				strokeWidth="4"
				strokeLinecap="round"
			/>
			<path
				d="M23 22.5v19l17-9.5-17-9.5Z"
				fill={`url(#${playFillId})`}
				strokeLinejoin="round"
			/>
			<path
				d="M37 41h11M37 47h8"
				stroke="#0f766e"
				strokeWidth="3"
				strokeLinecap="round"
			/>
			<circle cx="49" cy="30" r="3.5" fill="#22c7b8" />
		</svg>
	);
};
