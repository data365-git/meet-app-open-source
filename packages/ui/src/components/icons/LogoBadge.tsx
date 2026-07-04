export const LogoBadge = ({ className }: { className: string }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			fill="none"
			viewBox="0 0 48 48"
			preserveAspectRatio="xMidYMid meet"
			role="img"
			aria-label="data365"
			style={{
				aspectRatio: "1 / 1",
			}}
		>
			<defs>
				<linearGradient
					id="logoBadgeBg"
					x1="8"
					y1="4"
					x2="40"
					y2="44"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#16c8b8"></stop>
					<stop offset="1" stopColor="#1a5cf0"></stop>
				</linearGradient>
			</defs>
			<rect width="48" height="48" rx="12" fill="url(#logoBadgeBg)"></rect>
			<circle
				cx="24"
				cy="24"
				r="13"
				fill="none"
				stroke="#fff"
				strokeWidth="3"
			></circle>
			<path d="M21 17.5 L32.5 24 L21 30.5 Z" fill="#fff"></path>
		</svg>
	);
};
