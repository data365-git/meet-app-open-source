#!/usr/bin/env node
// Guard: the packaged extension zip (apps/web/public/365-extension.zip) must never
// go stale behind apps/browser-extension/src. Prod serves the COMMITTED zip (the
// Coolify image never builds the extension), so staleness ships silently.
// Incident: 2026-07-19 — owner's real meeting test ran a zip packaged at 07-18 13:41
// while 5 audio-guarantee commits landed 16:59–00:41 the same day. Never again.
//
// Modes:
//   node scripts/check-extension-zip-freshness.mjs            # history mode (pre-deploy/CI):
//     fails if the last commit touching apps/browser-extension/src is newer than
//     the last commit touching the zip.
//   node scripts/check-extension-zip-freshness.mjs --staged   # pre-commit mode:
//     fails if the STAGED changes touch apps/browser-extension/src but not the zip.
//     Escape hatch for mid-work commits: SKIP_ZIP_CHECK=1 git commit ...
//
// Fix when it fires:  cd apps/browser-extension && pnpm build && pnpm package
// then `git add apps/web/public/365-extension.zip apps/365-extension.zip` and retry.

import { execSync } from "node:child_process";

const SRC = "apps/browser-extension/src";
const ZIP = "apps/web/public/365-extension.zip";
const MANIFEST = "apps/browser-extension/manifest.json";

const git = (args) =>
	execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const fail = (msg) => {
	console.error(`\n[zip-freshness] BLOCKED: ${msg}`);
	console.error(
		`[zip-freshness] Fix: cd apps/browser-extension && pnpm build && pnpm package, then git add ${ZIP}`,
	);
	console.error(`[zip-freshness] Mid-work escape hatch: SKIP_ZIP_CHECK=1 git commit ...\n`);
	process.exit(1);
};

// The version guard, added 2026-08-05 after the SAME miss happened twice in one day:
// a shipped zip whose code had changed while manifest.json still read 0.5.7 (then
// 0.5.8). A repackaged zip under an unchanged version is worse than a stale zip —
// installed browsers never see an update, and two different builds then share one
// version string, so "which build is the team running?" becomes unanswerable.
// Both misses were caught by eye, after the automated loop reported converged.
const readVersion = (text) => {
	const m = /"version"\s*:\s*"([^"]+)"/.exec(text ?? "");
	return m ? m[1] : null;
};

const manifestVersionChanged = () => {
	// HEAD may not have the file (first commit) — treat that as "changed".
	let head = null;
	try {
		head = git(`show HEAD:${MANIFEST}`);
	} catch {
		return true;
	}
	const staged = git(`show :${MANIFEST}`);
	const before = readVersion(head);
	const after = readVersion(staged);
	if (!before || !after) return true; // cannot tell → do not block
	return before !== after;
};

const failVersion = () => {
	console.error(
		`\n[zip-freshness] BLOCKED: this commit changes extension src but leaves the manifest version unchanged.`,
	);
	console.error(
		`[zip-freshness] An installed browser never updates to a build that reuses its version string,`,
	);
	console.error(
		`[zip-freshness] and two different builds sharing one version make "which build is live?" unanswerable.`,
	);
	console.error(`[zip-freshness] Fix: bump "version" in ${MANIFEST}, then rebuild and repackage.`);
	console.error(`[zip-freshness] Mid-work escape hatch: SKIP_ZIP_CHECK=1 git commit ...\n`);
	process.exit(1);
};

if (process.env.SKIP_ZIP_CHECK === "1") {
	console.log("[zip-freshness] skipped via SKIP_ZIP_CHECK=1");
	process.exit(0);
}

if (process.argv.includes("--staged")) {
	const staged = git("diff --cached --name-only");
	const files = staged.split(/\r?\n/).filter(Boolean);
	const touchesSrc = files.some((f) => f.startsWith(`${SRC}/`));
	const touchesZip = files.includes(ZIP);
	if (touchesSrc && !touchesZip) {
		fail(
			"this commit changes extension src but not the packaged zip — prod would serve a stale extension.",
		);
	}
	if (touchesSrc && !files.includes(MANIFEST)) failVersion();
	if (touchesSrc && files.includes(MANIFEST) && !manifestVersionChanged()) {
		failVersion();
	}
	process.exit(0);
}

// History mode
const lastSrc = git(`log -1 --format=%ct -- ${SRC}`);
const lastZip = git(`log -1 --format=%ct -- ${ZIP}`);
if (!lastZip) fail("zip has no commit history — package and commit it.");
if (lastSrc && Number(lastSrc) > Number(lastZip)) {
	const fmt = (t) => new Date(Number(t) * 1000).toISOString();
	fail(
		`extension src last committed ${fmt(lastSrc)} but zip last committed ${fmt(lastZip)} — zip is STALE.`,
	);
}
console.log("[zip-freshness] OK — zip is at least as new as extension src.");
