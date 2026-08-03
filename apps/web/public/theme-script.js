(() => {
	var cookie = (() => {
		if (!document.cookie) return undefined;
		var match = document.cookie.match(/\W?theme=(\w+)/);
		return match ? match[1] : undefined;
	})();

	var pathname = window.location.pathname;
	var isDashboardPath =
		pathname.indexOf("/dashboard") === 0 ||
		pathname.indexOf("/login") === 0 ||
		pathname.indexOf("/onboarding") === 0 ||
		pathname.indexOf("/s/") === 0;
	var systemTheme = () => {
		return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	};
	var applyTheme = () => {
		document.body.classList.add(cookie || systemTheme());
	};

	if (isDashboardPath) {
		if (document.body) {
			applyTheme();
		} else {
			window.addEventListener("DOMContentLoaded", applyTheme, { once: true });
		}
	}
})();
