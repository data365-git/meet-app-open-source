import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "..", "web", "package.json"));
let chromium; for (const p of ["playwright","@playwright/test","playwright-core"]) { try { ({chromium}=require(p)); break } catch {} }
const dist = join(here, "..", "dist");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(),"cmdprobe-")), {
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
const cmds = await sw.evaluate(() => new Promise(r => chrome.commands.getAll(r)));
console.log("COMMANDS:", JSON.stringify(cmds));
const err = await sw.evaluate(() => ({ manifest: chrome.runtime.getManifest().version }));
console.log("SW OK:", JSON.stringify(err));
await ctx.close();
