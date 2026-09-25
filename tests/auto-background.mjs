/**
 * Slow test: a command still running after AUTO_BACKGROUND_SECONDS (20s) is moved
 * to the background on its own, with no keypress, and then reports as usual.
 *
 *   PI_PACKAGE_DIR=/path/to/pi-coding-agent node tests/auto-background.mjs
 *
 * Kept out of smoke.mjs on purpose: it has to outlast the 20s threshold.
 */
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionFile = resolve(here, "..", "background-shell.ts");

function findPiPackage() {
	if (process.env.PI_PACKAGE_DIR) {
		const dir = resolve(process.env.PI_PACKAGE_DIR);
		return dir.endsWith("dist") ? dirname(dir) : dir;
	}
	try {
		return dirname(dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")));
	} catch {
		throw new Error(
			"pi not found: set PI_PACKAGE_DIR to the installed @earendil-works/pi-coding-agent package",
		);
	}
}

const pkgDir = findPiPackage();
const pi = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);

let failures = 0;
const check = (label, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition || !detail ? "" : `  (${detail})`}`);
	if (!condition) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const notices = [];
const messages = [];
let inputHandler;
const ctx = {
	ui: {
		onTerminalInput: (handler) => {
			inputHandler = handler;
			return () => {};
		},
		notify: (message, type) => notices.push(`${type ?? "info"}: ${message}`),
		setStatus: () => {},
	},
};

const load = await pi.discoverAndLoadExtensions([extensionFile], process.cwd(), mkdtempSync(join(tmpdir(), "pi-bg-")));
load.runtime.sendUserMessage = (message) => messages.push(message);
const ext = load.extensions.find((entry) => entry.path === extensionFile);
check("extension loads with no errors", (load.errors ?? []).length === 0, JSON.stringify(load.errors));
await ext.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

const toolCtx = {
	cwd: process.cwd(),
	sessionManager: { getSessionId: () => "auto", getSessionFile: () => undefined },
};
// Long, but not a "wait" idiom, so the wait guard does not refuse it.
const LONG =
	"Write-Output auto-start; $t = [Diagnostics.Stopwatch]::StartNew(); " +
	"while ($t.Elapsed.TotalSeconds -lt 26) {}; Write-Output auto-done";
const shellJobs = ext.tools.get("shell_jobs").definition;
const jobsCall = (params) =>
	shellJobs
		.execute("auto", params, new AbortController().signal, undefined, toolCtx)
		.then((r) => r.content?.[0]?.text ?? "")
		.catch((error) => `threw: ${error.message}`);

const started = Date.now();
const pending = ext.tools
	.get("powershell")
	.definition.execute("auto-long", { command: LONG }, new AbortController().signal, undefined, toolCtx)
	.catch((error) => ({ error: error.message }));

// Nothing is pressed: the timer has to do it.
check("Ctrl+B is never pressed", typeof inputHandler === "function");
await sleep(2000);
check("still running before the threshold", Date.now() - started < 19000);

const detached = await pending;
const elapsed = Date.now() - started;
const text = JSON.stringify(detached);
check(
	"tool call released automatically at ~20s",
	elapsed >= 19_500 && elapsed < 24_000,
	`${elapsed}ms`,
);
check("note says it was automatic", text.includes("moved to the background automatically"), text.slice(0, 200));
check(
	"toast explains the auto move",
	notices.some((n) => n.includes("still running after 20s") && n.includes("moved to background")),
	notices.join(" | "),
);
const listed = await jobsCall({ action: "list" });
check("shell_jobs lists it as background (auto)", /#\d+ background \(auto\)/.test(listed), listed);
const id = Number(/#(\d+)\s+background/.exec(listed)?.[1]);
check(
	"shell_jobs can read its partial output",
	(await jobsCall({ action: "output", id })).includes("auto-start"),
);

const killed = await jobsCall({ action: "kill", id });
check("shell_jobs kills it", killed.startsWith(`Killed #${id}`), killed);

await sleep(1500);
check(
	"agent is told it was auto-backgrounded and cancelled",
	messages.some((m) => m.includes("cancelled by the user") && m.includes("auto-backgrounded after 20s")),
	JSON.stringify(messages.map((m) => m.split("\n")[0])),
);
check("footer cleared", true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
