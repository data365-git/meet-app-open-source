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
		// This file is inlined into <head>, so <body> does not exist yet on a
		// cold load. Put the class on <html> IMMEDIATELY: the radix palette and
		// every Tailwind dark: utility key off `.dark` on any ancestor, so the
		// very first paint is already correct and there is no light flash.
		// <body> still gets the class below, because the theme toggle and the
		// AI chat both read and write document.body.classList.
		var decided = cookie || systemTheme();
		if (document.documentElement) {
			document.documentElement.classList.add(decided);
		}
		if (document.body) {
			applyTheme();
		} else {
			window.addEventListener("DOMContentLoaded", applyTheme, { once: true });
		}
	}
})();
