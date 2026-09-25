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
const started = Date.now();
const long = run("long", `Start-Sleep -Seconds 6; Write-Output late-result; ${PS_PROBE}`);
await sleep(500);
check("Ctrl+B consumed while running", JSON.stringify(inputHandler("\x02")) === '{"consume":true}');
const detached = await long;
const released = Date.now() - started;
const detachedText = JSON.stringify(detached);
check(
	"tool call released early",
	released < 1500 && detachedText.includes("moved to background"),
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
const bareTimeout = await run("timeout-ok", "timeout 30 Write-Output deadline-style");
check(
	"command deadline (timeout N) is not treated as a wait",
	!JSON.stringify(bareTimeout).includes("refused"),
	JSON.stringify(bareTimeout),
);

// 5. Completion report reaches the user and the agent.
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
	"footer shows the job, then clears",
	statuses.some((status) => status.includes("bg: #")) && statuses.at(-1) === "background-jobs=undefined",
	statuses.join(" | "),
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
