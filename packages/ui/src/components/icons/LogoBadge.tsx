export const LogoBadge = ({ className }: { className: string }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			fill="none"
			viewBox="0 0 200 200"
			preserveAspectRatio="xMidYMid meet"
			role="img"
			aria-label="data365"
			style={{
				aspectRatio: "1 / 1",
			}}
		>
			<defs>
				<linearGradient
					id="logoBadgeRing"
					x1="100"
					y1="36"
					x2="52"
					y2="164"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#16c8b8"></stop>
					<stop offset="1" stopColor="#1a5cf0"></stop>
				</linearGradient>
			</defs>
			<rect width="200" height="200" rx="44" fill="#fff"></rect>
			<path
				d="M119 44.4A64 64 0 1 1 134 55"
				stroke="url(#logoBadgeRing)"
				strokeWidth="11.6"
				strokeLinecap="round"
			></path>
			<path
				d="M89 74 L133 100 L89 126 Z"
				fill="#2e7dff"
				stroke="#2e7dff"
				strokeWidth="6"
				strokeLinejoin="round"
			></path>
			<circle cx="126.2" cy="52" r="10" fill="#16c8b8"></circle>
		</svg>
	);
};
