// 30-second decisive probe: does chrome.tabCapture.getMediaStreamId require a
// real toolbar-icon gesture in a Playwright-launched, --load-extension context?
//   RESOLVES  -> no gesture machinery needed; run-proof can drive START_INSTRUCTION directly.
//   THROWS "not been invoked" -> gesture rule holds; build the commands/UIA rung.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const require = createRequire(join(here, "..", "..", "web", "package.json"));
let chromium;
for (const pkg of ["playwright", "@playwright/test", "playwright-core"]) {
	try {
		({ chromium } = require(pkg));
		break;
	} catch {}
}

const SERVE_PORT = 8443;
const server = spawn(process.execPath, [join(here, "serve.mjs"), String(SERVE_PORT)], {
	stdio: ["ignore", "pipe", "pipe"],
});
await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("fake-meet") && r()));

const context = await chromium.launchPersistentContext(
	mkdtempSync(join(tmpdir(), "probe-")),
	{
		headless: false,
		args: [
			`--disable-extensions-except=${distDir}`,
			`--load-extension=${distDir}`,
			`--host-resolver-rules=MAP meet.google.com:443 127.0.0.1:${SERVE_PORT}`,
			"--ignore-certificate-errors",
			"--autoplay-policy=no-user-gesture-required",
		],
	},
);
try {
	let [sw] = context.serviceWorkers();
	if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });

	const meetPage = await context.newPage();
	await meetPage.goto("https://meet.google.com/abc-defg-hij?tone=1", {
		waitUntil: "domcontentloaded",
	});
	await meetPage.bringToFront();

	const result = await sw.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (!tab?.id) return { ok: false, error: "no active tab" };
		try {
			const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
			return { ok: true, streamId: typeof id, tabUrl: tab.url };
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e), tabUrl: tab.url };
		}
	});
	console.log("PROBE:", JSON.stringify(result));
} finally {
	await context.close().catch(() => {});
	server.kill();
}
