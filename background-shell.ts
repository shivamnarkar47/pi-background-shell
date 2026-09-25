/**
 * background-shell.ts - Ctrl+B moves a running shell tool call into the background.
 *
 * When the model runs a bash/powershell command that blocks the turn, press Ctrl+B:
 *   - the tool call returns immediately with a note that the command is still running,
 *     so the turn continues,
 *   - the process keeps running (Escape after backgrounding does not kill it),
 *   - when it exits, pi shows a toast and sends the details (exit code, duration,
 *     output tail) to the agent as a user message.
 *
 * When no command is running the key is passed through, so the default
 * "cursor left" behaviour of Ctrl+B is preserved.
 *
 * Delete this file and run /reload to go back to blocking commands.
 */

import { StringDecoder } from "node:string_decoder";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createLocalBashOperations,
	createLocalPowerShellOperations,
	createPowerShellToolDefinition,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

type ExecResult = { exitCode: number | null };
type ExecOutcome = { ok: true; result: ExecResult } | { ok: false; error: unknown };

const STATUS_KEY = "background-jobs";
const CAPTURE_LIMIT = 40_000; // characters of output kept in memory per job
const REPORT_TAIL = 4_000; // characters of output included in the completion message

interface Job {
	id: number;
	tool: string;
	command: string;
	cwd: string;
	startedAt: number;
	output: string;
	/** Detaches the job from its tool call. Returns false if the call already finished. */
	detach: (() => boolean) | undefined;
}

interface SharedState {
	nextId: number;
	running: Map<number, Job>;
	background: Map<number, Job>;
	uiCtx: ExtensionContext | undefined;
	messageApi: ((message: string) => void) | undefined;
}

// /reload re-imports this file, so the job registry lives on globalThis: a command
// started before a reload stays visible to the new input handler and still reports.
const state: SharedState =
	(globalThis as unknown as Record<symbol, SharedState | undefined>)[
		Symbol.for("pi.background-shell.state")
	] ??= {
		nextId: 1,
		running: new Map(),
		background: new Map(),
		uiCtx: undefined,
		messageApi: undefined,
	};

// Per-instance: the UI clears extension input listeners on reload itself.
let unsubscribeInput: (() => void) | undefined;

/* ------------------------------------------------------------------ helpers */

function notify(message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		state.uiCtx?.ui.notify(message, type);
	} catch {
		/* stale context - the report still reaches the agent */
	}
}

function updateStatus(): void {
	try {
		const ids = [...state.background.keys()].map((id) => `#${id}`).join(" ");
		state.uiCtx?.ui.setStatus(STATUS_KEY, ids ? `bg: ${ids}` : undefined);
	} catch {
		/* ignore */
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------ agent rules */

const RULE_HEADING = "## Backgrounded shell commands";

/** Tells the model, at the moment it matters, that waiting is pointless. */
function backgroundedNote(jobId: number): string {
	return (
		`[pi] Command moved to background (job #${jobId}). It is still running; pi will message you ` +
		`with the exit code and output when it finishes. Do not re-run it, and do not sleep, ` +
		`Wait-Sleep or poll to wait for it. If you have nothing else to do, end your turn now.`
	);
}

/** The same rule, so it also holds on turns where nothing was backgrounded. */
const SYSTEM_RULE = `${RULE_HEADING}

A shell tool result containing "Command moved to background" means the process is still running.
Pi delivers its exit code and output as a message when it exits.

- Never re-run a backgrounded command, and never wait for it: no \`sleep\`, \`Start-Sleep\`,
  \`Wait-Sleep\`, \`timeout\`, or any poll/re-check loop.
- If you have other work, do it. If you have nothing else to do, end your turn immediately -
  the result arrives on its own.`;

/* ------------------------------------------------------- operations wrapper */

/**
 * Wraps pi's shell backend so a running exec can be released early.
 *
 * The child process is spawned with our own AbortController: the tool call's
 * signal is only forwarded until the job is detached, which is what lets a
 * backgrounded command survive the turn (and a later Escape).
 */
function wrapOperations(tool: string, base: BashOperations): BashOperations {
	return {
		exec: (command, cwd, options) => {
			const job: Job = {
				id: state.nextId++,
				tool,
				command,
				cwd,
				startedAt: Date.now(),
				output: "",
				detach: undefined,
			};
			state.running.set(job.id, job);
			const decoder = new StringDecoder("utf8");
			const controller = new AbortController();
			let detached = false;
			let finished = false;
			const forwardAbort = () => {
				if (!detached) controller.abort();
			};
			options.signal?.addEventListener("abort", forwardAbort, { once: true });

			const run = Promise.resolve()
				.then(() =>
					base.exec(command, cwd, {
						...options,
						signal: controller.signal,
						onData: (data) => {
							job.output = (job.output + decoder.write(data)).slice(-CAPTURE_LIMIT);
							if (!detached) options.onData(data);
						},
					}),
				)
				.then(
					(result): ExecOutcome => ({ ok: true, result }),
					(error): ExecOutcome => ({ ok: false, error }),
				)
				.then((outcome) => {
					finished = true;
					job.detach = undefined;
					state.running.delete(job.id);
					options.signal?.removeEventListener("abort", forwardAbort);
					if (detached) {
						state.background.delete(job.id);
						report(job, outcome);
						updateStatus();
					}
					return outcome;
				});

			return new Promise<ExecResult>((resolve, reject) => {
				run.then(
					(outcome) => (outcome.ok ? resolve(outcome.result) : reject(outcome.error)),
					reject,
				);
				job.detach = () => {
					if (finished || detached) return false;
					detached = true;
					state.running.delete(job.id);
					state.background.set(job.id, job);
					options.onData(Buffer.from(`\n\n${backgroundedNote(job.id)}`));
					resolve({ exitCode: 0 });
					return true;
				};
			});
		},
	};
}

/* ------------------------------------------------------------ completion */

function report(job: Job, outcome: ExecOutcome): void {
	const seconds = ((Date.now() - job.startedAt) / 1000).toFixed(1);
	const exitCode = outcome.ok ? outcome.result.exitCode : undefined;
	const failure = outcome.ok
		? exitCode === null
			? "terminated without an exit code"
			: exitCode !== 0
				? `exit code ${exitCode}`
				: undefined
		: errorMessage(outcome.error);
	const succeeded = failure === undefined;

	notify(
		`Background ${job.tool} #${job.id} finished in ${seconds}s (${succeeded ? "exit 0" : failure})`,
		succeeded ? "info" : "warning",
	);

	const message = [
		`[background ${job.tool} command #${job.id}] ${
			succeeded ? "finished successfully" : "failed"
		} after ${seconds}s (${succeeded ? "exit code 0" : failure}).`,
		`command: ${job.command}`,
		`cwd: ${job.cwd}`,
		"",
		"--- output (tail) ---",
		job.output.slice(-REPORT_TAIL).trim() || "(no output)",
	].join("\n");

	try {
		state.messageApi?.(message);
	} catch {
		/* stale runtime - the toast was already shown */
	}
}

/* ----------------------------------------------------------- key handling */

/** Ctrl+B: legacy `\x02`, and kitty CSI-u `ESC [ 98 ; 5 u` (b with ctrl modifier). */
function isCtrlB(data: string): boolean {
	if (data === "\x02") return true;
	const match = data.match(/^\x1b\[(\d+);(\d+)u$/);
	return match !== null && match[1] === "98" && match[2] === "5";
}

function handleInput(data: string): { consume: true } | undefined {
	if (!isCtrlB(data)) return undefined;
	const jobs = [...state.running.values()];
	if (jobs.length === 0) return undefined; // nothing running: keep the default cursor-left key
	const moved = jobs.filter((job) => job.detach?.());
	if (moved.length > 0) {
		updateStatus();
		notify(
			`Shell command${moved.length > 1 ? "s" : ""} ${moved
				.map((job) => `#${job.id}`)
				.join(", ")} moved to background`,
		);
	}
	return { consume: true };
}

/* ------------------------------------------------------------- extension */

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	let shellPath: string | undefined;
	let commandPrefix: string | undefined;
	try {
		const settings = SettingsManager.create(cwd, getAgentDir());
		shellPath = settings.getShellPath();
		commandPrefix = settings.getShellCommandPrefix();
	} catch {
		/* fall back to pi's defaults */
	}

	// Override the built-in shell tools: same schema, prompt and renderers,
	// but execution goes through the wrapper that can be detached with Ctrl+B.
	pi.registerTool(
		createBashToolDefinition(cwd, {
			commandPrefix,
			shellPath,
			operations: wrapOperations("bash", createLocalBashOperations({ shellPath })),
		}),
	);
	pi.registerTool(
		createPowerShellToolDefinition(cwd, {
			operations: wrapOperations("powershell", createLocalPowerShellOperations()),
		}),
	);

	state.messageApi = (message: string) => pi.sendUserMessage(message, { deliverAs: "steer" });

	// Append the rule to the system prompt so it is present on every turn, not just
	// the turn that backgrounds something.
	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(RULE_HEADING)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_RULE}` };
	});

	pi.on("session_start", (_event, ctx) => {
		state.uiCtx = ctx;
		unsubscribeInput?.();
		unsubscribeInput =
			typeof ctx.ui.onTerminalInput === "function" ? ctx.ui.onTerminalInput(handleInput) : undefined;
		updateStatus();
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
	});
}
