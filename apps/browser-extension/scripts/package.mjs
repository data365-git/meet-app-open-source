import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const distDir = join(rootDir, "dist");
const outputFile = join(rootDir, "..", "365-extension.zip");
const publicOutputFile = join(rootDir, "..", "web", "public", "365-extension.zip");
const manifestFile = join(distDir, "manifest.json");

if (!existsSync(distDir)) {
	console.error("dist/ directory not found. Run 'pnpm build' first.");
	process.exit(1);
}

try {
	const manifestVersion = JSON.parse(readFileSync(manifestFile, "utf8")).version;

	try {
		execFileSync("zip", ["-r", outputFile, "."], {
			cwd: distDir,
			stdio: "inherit",
		});
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
		// Windows has no `zip` binary. bsdtar (`tar -a -c -f x.zip -C dist .`)
		// DOES produce a valid zip, but every entry is named "./foo" — and
		// Windows Explorer renders such an archive as EMPTY, so the owner
		// downloads it, sees nothing, and can't install the extension.
		// (Shipped exactly that bug on 2026-07-19.) Compress-Archive with a
		// `dist\*` glob writes plain top-level entries that Explorer reads.
		execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				`Compress-Archive -Path '${join(distDir, "*")}' -DestinationPath '${outputFile}' -Force`,
			],
			{ stdio: "inherit" },
		);
	}
	console.log(`Package created: ${outputFile}`);
	console.log(`Manifest version: ${manifestVersion}`);

	if (existsSync(dirname(publicOutputFile))) {
		copyFileSync(outputFile, publicOutputFile);
		console.log(`Copied package to: ${publicOutputFile}`);
	}
} catch (err) {
	console.error("Failed to create package:", err.message);
	process.exit(1);
}
