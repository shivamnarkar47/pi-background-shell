/**
 * Loads background-shell.ts through pi's own extension loader, then exercises a
 * normal run, Ctrl+B backgrounding and the completion report.
 *
 *   PI_PACKAGE_DIR=/path/to/pi-coding-agent node tests/smoke.mjs
 *
 * PI_PACKAGE_DIR may point at the package root or its dist folder, and can be
 * omitted when @earendil-works/pi-coding-agent resolves from this file.
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

// Load exactly this file, in a throwaway agent dir so nothing else is discovered.
const agentDir = mkdtempSync(join(tmpdir(), "pi-background-shell-"));
const load = await pi.discoverAndLoadExtensions([extensionFile], process.cwd(), agentDir);
check("loads with no errors", (load.errors ?? []).length === 0, JSON.stringify(load.errors));

const ext = load.extensions.find((entry) => entry.path === extensionFile);
check("extension discovered", Boolean(ext), (load.extensions ?? []).map((e) => e.path).join(", "));

const registered = [...(ext?.tools.keys() ?? [])];
check(
	"overrides bash and powershell",
	registered.includes("bash") && registered.includes("powershell"),
	registered.join(", "),
);

// Stand in for the TUI: capture notifications, the footer status and the input hook.
const notices = [];
const statuses = [];
const messages = [];
const entries = [];
let inputHandler;
const ctx = {
	ui: {
		onTerminalInput: (handler) => {
			inputHandler = handler;
			return () => {};
		},
		notify: (message, type) => notices.push(`${type ?? "info"}: ${message}`),
		setStatus: (key, value) => statuses.push(`${key}=${value}`),
	},
};
load.runtime.sendUserMessage = (message, options) => messages.push({ message, options });
load.runtime.appendEntry = (type, data) => entries.push({ type, data });

await ext.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
check("terminal input hook installed", typeof inputHandler === "function");

// The standing rule must be appended to the system prompt, and only once.
const beforeAgentStart = ext.handlers.get("before_agent_start")?.[0];
const basePrompt = "BASE PROMPT";
const injected = beforeAgentStart?.({ type: "before_agent_start", prompt: "hi", systemPrompt: basePrompt }, ctx);
check(
	"system prompt rule appended",
	typeof injected?.systemPrompt === "string" &&
		injected.systemPrompt.startsWith(basePrompt) &&
		injected.systemPrompt.includes("Backgrounded shell commands"),
	injected?.systemPrompt,
);
check(
	"system prompt rule not appended twice",
	beforeAgentStart({ type: "before_agent_start", prompt: "hi", systemPrompt: injected.systemPrompt }, ctx) ===
		undefined,
);

const toolCtx = {
	cwd: process.cwd(),
	sessionManager: { getSessionId: () => "smoke", getSessionFile: () => undefined },
};
const run = (id, command) =>
	ext.tools
		.get("powershell")
		.definition.execute(id, { command }, new AbortController().signal, undefined, toolCtx)
		.catch((error) => ({ error: error.message }));

// 1. Ctrl+B with nothing running stays the editor's key.
check("Ctrl+B passes through when idle", inputHandler("\x02") === undefined);

// 2. A normal command still behaves like the built-in tool.
const quick = await run("quick", "Write-Output hi");
check("normal run returns output", JSON.stringify(quick).includes("hi"), JSON.stringify(quick));

// 2b. timeout and sleep are refused even with nothing backgrounded.
const bareTimeout = await run("timeout-ok", "timeout 30 Write-Output deadline-style");
check(
	"timeout is refused with nothing backgrounded",
	typeof bareTimeout?.error === "string" &&
		bareTimeout.error.includes("refused") &&
		bareTimeout.error.includes("timeout"),
	JSON.stringify(bareTimeout),
);
const bareSleep = await run("sleep-ok", "Start-Sleep -Seconds 2; Write-Output after-sleep");
check(
	"sleep is refused with nothing backgrounded",
	typeof bareSleep?.error === "string" &&
		bareSleep.error.includes("refused") &&
		bareSleep.error.includes("sleep or wait"),
	JSON.stringify(bareSleep),
);
check(
	"refusals are toasted",
	notices.some((n) => n.includes("Refused a timeout")) && notices.some((n) => n.includes("Refused a sleep")),
	notices.join(" | "),
);

// 3. The overridden tools must resolve the same shell as pi's built-in tools.
//    Backgrounded runs go through the same wrapper, so this is what keeps a
//    backgrounded command on the default shell.
const settings = pi.SettingsManager.create(process.cwd(), pi.getAgentDir());
const builtins = {
	bash: pi.createBashToolDefinition(process.cwd(), {
		commandPrefix: settings.getShellCommandPrefix(),
		shellPath: settings.getShellPath(),
	}),
	powershell: pi.createPowerShellToolDefinition(process.cwd()),
};
const execTool = (definition, id, command) =>
	definition
		.execute(id, { command }, new AbortController().signal, undefined, toolCtx)
		.catch((error) => ({ error: error.message }));
const output = (result) => (result?.content?.[0]?.text ?? "").trim();
const failed = (result) => typeof result?.error === "string";

const PS_PROBE = 'Write-Output "$($PSVersionTable.PSEdition):$([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)"';
const BASH_PROBE = 'printf %s "|$BASH_VERSION|$(uname -sr)"';

const psForeground = await run("probe-ps", PS_PROBE);
const psBuiltin = await execTool(builtins.powershell, "probe-ps-builtin", PS_PROBE);
check(
	"powershell tool uses the same shell as pi's built-in",
	!failed(psForeground) && !failed(psBuiltin) && output(psForeground) === output(psBuiltin),
	`${output(psForeground)} vs ${output(psBuiltin)} ${JSON.stringify(psBuiltin)}`,
);

const bashForeground = await execTool(ext.tools.get("bash").definition, "probe-bash", BASH_PROBE);
const bashBuiltin = await execTool(builtins.bash, "probe-bash-builtin", BASH_PROBE);
if (failed(bashForeground) || failed(bashBuiltin)) {
	console.log(`SKIP  no bash shell here (${JSON.stringify(bashForeground).slice(0, 120)})`);
} else {
	check(
		"bash tool uses the same shell as pi's built-in",
		output(bashForeground) === output(bashBuiltin),
		`${output(bashForeground)} vs ${output(bashBuiltin)}`,
	);
}

// 4. Ctrl+B detaches a running command.
//    A busy loop, not Start-Sleep: sleep commands are refused outright.
const started = Date.now();
const long = run(
	"long",
	`Write-Output late-result; ${PS_PROBE}; $t = [Diagnostics.Stopwatch]::StartNew(); ` +
		`while ($t.Elapsed.TotalSeconds -lt 6) {}; Write-Output late-done`,
);
await sleep(500);
check("Ctrl+B consumed while running", JSON.stringify(inputHandler("\x02")) === '{"consume":true}');
const detached = await long;
const released = Date.now() - started;
const detachedText = JSON.stringify(detached);
check(
	"tool call released early",
	released < 1500 && detachedText.includes("moved to the background"),
	`${released}ms ${detachedText}`,
);
check("note tells the model to end its turn", detachedText.includes("end your turn"), detachedText);

// 5. While a job is backgrounded: wait commands are refused, other work is not.
const refused = await run("wait-attempt", "Start-Sleep -Seconds 30");
check(
	"wait command refused while backgrounded",
	typeof refused?.error === "string" && refused.error.includes("refused") && refused.error.includes("wait command"),
	JSON.stringify(refused),
);
const refusedPing = await run("ping-attempt", "ping -n 4 127.0.0.1 > $null");
check(
	"ping-as-sleep refused while backgrounded",
	typeof refusedPing?.error === "string" && refusedPing.error.includes("refused"),
	JSON.stringify(refusedPing),
);
const otherWork = await run("other-work", "Write-Output other-work");
check(
	"other work still allowed while backgrounded",
	JSON.stringify(otherWork).includes("other-work"),
	JSON.stringify(otherWork),
);

// 6. /background lists jobs and kills them.
//    The victim must not look like a wait command, or the guard refuses it first.
const backgroundCommand = ext.commands.get("background");
check("/background command registered", Boolean(backgroundCommand?.handler));

const victim = run(
	"victim",
	"$t = [Diagnostics.Stopwatch]::StartNew(); while ($t.Elapsed.TotalSeconds -lt 20) {}; Write-Output never-printed",
);
await sleep(700);
check("second Ctrl+B detaches the new job", JSON.stringify(inputHandler("\x02")) === '{"consume":true}');
check("victim tool call was released, not refused", !JSON.stringify(await victim).includes("refused"));
await victim;

await backgroundCommand.handler("", ctx);
const card = entries.at(-1);
const rows = card?.data?.rows ?? [];
check("/background card lists the jobs", card?.type === "background-shell-jobs" && rows.length >= 1, JSON.stringify(card));
const victimRow = rows.find((row) => row.command.includes("never-printed"));
check(
	"card shows the backgrounded job with its command",
	Boolean(victimRow) && victimRow.detached === true,
	JSON.stringify(rows),
);

if (victimRow) {
	await backgroundCommand.handler(`kill ${victimRow.id}`, ctx);
	check("kill confirms with a toast", notices.some((n) => n.includes(`Killed #${victimRow.id}`)), notices.join(" | "));
} else {
	check("kill step skipped: no victim row", false, "the victim job never appeared in the card");
}
check(
	"killing an unknown id is reported, not thrown",
	(await backgroundCommand.handler("kill 9999", ctx)) === undefined &&
		notices.some((n) => n.includes("No running or backgrounded job: #9999")),
	notices.join(" | "),
);
check(
	"a non-numeric id is reported, not thrown",
	(await backgroundCommand.handler("kill abc", ctx)) === undefined &&
		notices.some((n) => n.includes("No such job: abc")),
	notices.join(" | "),
);

// 7. Duplicate guard and shell_jobs, all while a job is still backgrounded.
const VICTIM_BODY =
	"Write-Output victim-start; $t = [Diagnostics.Stopwatch]::StartNew(); " +
	"while ($t.Elapsed.TotalSeconds -lt 20) {}; Write-Output victim-done";
const shellJobs = ext.tools.get("shell_jobs");
check("shell_jobs tool registered", Boolean(shellJobs?.definition?.execute));
const jobsCall = (id, params) =>
	shellJobs.definition
		.execute(id, params, new AbortController().signal, undefined, toolCtx)
		.then((r) => r.content?.[0]?.text ?? "")
		.catch((error) => `threw: ${error.message}`);

const live = run("live", VICTIM_BODY);
await sleep(700);
check("Ctrl+B detaches the live job", JSON.stringify(inputHandler("\x02")) === '{"consume":true}');
await live;

const listed = await jobsCall("list", { action: "list" });
const liveId = Math.max(
	...listed
		.split("\n")
		.filter((line) => line.includes("victim-start"))
		.map((line) => Number(/#(\d+)/.exec(line)[1])),
);
check("shell_jobs list shows it as background", listed.includes(`#${liveId}`) && listed.includes("background"), listed);

const duplicate = await run(
	"duplicate",
	`cd ${process.cwd()} && ${VICTIM_BODY} > $null 2>&1; Select-String -Pattern victim-done`,
);
check(
	"duplicate of a backgrounded command refused",
	typeof duplicate?.error === "string" &&
		duplicate.error.includes("already running this command") &&
		duplicate.error.includes(`#${liveId}`),
	JSON.stringify(duplicate),
);
const stillAllowed = await run("other-program", "Write-Output unrelated-work");
check(
	"a different command is still allowed",
	JSON.stringify(stillAllowed).includes("unrelated-work"),
	JSON.stringify(stillAllowed),
);

const partial = await jobsCall("output", { action: "output", id: liveId });
check(
	"shell_jobs output returns what the job printed so far",
	partial.includes("victim-start") && partial.includes("still running"),
	partial.slice(0, 200),
);
check(
	"shell_jobs output for an unknown id is reported",
	(await jobsCall("unknown", { action: "output", id: 4242 })).includes("No shell job #4242"),
);
const killedByTool = await jobsCall("kill", { action: "kill", id: liveId });
check("shell_jobs kill stops a job", killedByTool.startsWith(`Killed #${liveId}`), killedByTool);

// 8. Completion report reaches the user and the agent.
await sleep(6500);
check(
	"toast shown on completion",
	notices.some((notice) => notice.includes("finished in")),
	notices.join(" | "),
);
check(
	"agent messaged with details",
	messages.some((m) => m.message.includes("late-result") && m.options?.deliverAs === "steer"),
	JSON.stringify(messages),
);
const backgroundReport = messages.find((m) => m.message.includes("late-result"))?.message ?? "";
check(
	"backgrounded job ran under the same shell as a foreground run",
	!failed(psForeground) &&
		output(psForeground).length > 0 &&
		backgroundReport.includes(output(psForeground)),
	`foreground=${output(psForeground)} report=${JSON.stringify(backgroundReport.slice(-200))}`,
);
check(
	"killed job reports as cancelled by the user",
	messages.some((m) => m.message.includes("cancelled by the user")) &&
		notices.some((n) => n.includes("Cancelled background")),
	JSON.stringify(messages.map((m) => m.message.split("\n")[0])),
);
check(
	"footer shows the job, then clears",
	statuses.some((status) => status.includes("bg: #")) && statuses.at(-1) === "background-jobs=undefined",
	statuses.join(" | "),
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
