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
 * /background            list running and backgrounded shell commands
 * /background kill <id>  kill one (or "all")
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
import { Box, Text } from "@earendil-works/pi-tui";

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
	/** Owns the child process, so /background can kill a detached job. */
	controller: AbortController | undefined;
	/** Whether the user killed it from /background (changes how the report reads). */
	killed: boolean;
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
  \`Wait-Sleep\`, \`timeout\`, or any poll/re-check loop. Pi refuses such commands outright
  while a backgrounded command is still running.
- If you have other work, do it. If you have nothing else to do, end your turn immediately -
  the result arrives on its own.`;

/**
 * Wait idioms the model reaches for instead of ending its turn. Best effort: a wait
 * hidden in a script it wrote itself is not detected.
 */
const WAIT_IDIOMS: readonly RegExp[] = [
	/(^|[\s;&|(])(?:sleep|tsleep)\s+\d/i, // sleep 280
	/\b(?:start-sleep|wait-sleep|wait-event)\b/i, // Start-Sleep 30
	/\btimeout\s+\/t\b/i, // timeout /t 30
	/\bping\s+-[nc]\s*(?:[2-9]|\d{2,})\b/i, // ping -n 11 127.0.0.1
	/\btime\.sleep\s*\(/i, // python -c "import time; time.sleep(60)"
	/\bsettimeout\s*\(/i, // node -e "setTimeout(done, 60000)"
];

function isWaitCommand(command: string): boolean {
	return WAIT_IDIOMS.some((pattern) => pattern.test(command));
}

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
			if (state.background.size > 0 && isWaitCommand(command)) {
				const ids = [...state.background.keys()].map((id) => `#${id}`).join(", ");
				notify(`Refused a wait command while ${ids} runs in the background`);
				throw new Error(
					`[pi] refused: ${command.slice(0, 200)} is a wait command, and background job(s) ${ids} ` +
						`are still running. Do not sleep or poll to wait for them. Do other work, or end ` +
						`your turn - pi will message you with the exit code and output when the job finishes.`,
				);
			}
			const job: Job = {
				id: state.nextId++,
				tool,
				command,
				cwd,
				startedAt: Date.now(),
				output: "",
				detach: undefined,
				controller: undefined,
				killed: false,
			};
			state.running.set(job.id, job);
			const decoder = new StringDecoder("utf8");
			const controller = new AbortController();
			job.controller = controller;
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
					job.controller = undefined;
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
	const failure = job.killed
		? "cancelled by the user"
		: outcome.ok
			? exitCode === null
				? "terminated without an exit code"
				: exitCode !== 0
					? `exit code ${exitCode}`
					: undefined
			: errorMessage(outcome.error);
	const succeeded = failure === undefined;

	notify(
		job.killed
			? `Cancelled background ${job.tool} #${job.id} after ${seconds}s`
			: `Background ${job.tool} #${job.id} finished in ${seconds}s (${succeeded ? "exit 0" : failure})`,
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

/* ------------------------------------------------------ /background command */

const JOBS_ENTRY = "background-shell-jobs";

interface JobRow {
	id: number;
	tool: string;
	command: string;
	elapsedMs: number;
	tail: string;
	detached: boolean;
}

interface JobsCard {
	rows: JobRow[];
	message?: string;
}

function fmtElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function jobRow(job: Job, detached: boolean): JobRow {
	return {
		id: job.id,
		tool: job.tool,
		command: job.command,
		elapsedMs: Date.now() - job.startedAt,
		tail: clip(job.output.trimEnd().split("\n").pop() ?? "", 44),
		detached,
	};
}

/** Kills a running or backgrounded job. Returns false when the id is unknown. */
function killJob(id: number): boolean {
	const job = state.background.get(id) ?? state.running.get(id);
	if (!job?.controller) return false;
	job.killed = true;
	job.controller.abort();
	return true;
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

	// Override the built-in shell tools: same schema, prompt and renderers, and the
	// same shell resolution (pi re-resolves getShellConfig / getPowerShellConfig on
	// every exec, and shellPath/commandPrefix come from the same settings the
	// built-ins use), so a backgrounded run is indistinguishable from a foreground
	// one apart from when its tool call returns.
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

	// ===== /background: inspect or kill shell jobs =====
	pi.registerEntryRenderer<JobsCard>(JOBS_ENTRY, (entry, _options, theme) => {
		const card = entry.data;
		if (!card) return undefined;
		const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
		const count = card.rows.length;
		box.addChild(
			new Text(
				theme.fg("accent", theme.bold("⏱ Background shell")) +
					theme.fg("dim", count === 0 ? "" : `  ${count} command${count === 1 ? "" : "s"}`),
				0,
				0,
			),
		);
		for (const row of card.rows) {
			box.addChild(
				new Text(
					theme.fg(row.detached ? "warning" : "dim", `${row.detached ? "bg  " : "run "} #${row.id}`.padEnd(9)) +
						theme.fg("dim", fmtElapsed(row.elapsedMs).padEnd(8)) +
						theme.fg("text", clip(row.command, 44)) +
						(row.tail ? theme.fg("dim", `  … ${row.tail}`) : ""),
					0,
					0,
				),
			);
		}
		if (card.message) box.addChild(new Text(theme.fg("dim", card.message), 0, 0));
		box.addChild(
			new Text(theme.fg("dim", "kill one: /background kill <id>  ·  all: /background kill all"), 0, 0),
		);
		return box;
	});

	pi.registerCommand("background", {
		description: "List running/backgrounded shell commands, or kill them",
		handler: async (args: string) => {
			const [verb, arg] = args.trim().split(/\s+/).filter(Boolean);
			if (verb === "kill") {
				const all = arg === "all";
				const ids = all ? [...state.background.keys()] : arg ? [Number(arg)] : [];
				if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
					notify(arg ? `No such job: ${arg}` : "Usage: /background kill <id|all>", "warning");
					return;
				}
				const killed = ids.filter((id) => killJob(id));
				if (killed.length === 0) {
					notify(all ? "No backgrounded jobs" : `No running or backgrounded job: #${arg}`, "warning");
					return;
				}
				notify(`Killed ${killed.map((id) => `#${id}`).join(", ")}`);
				updateStatus();
				return;
			}
			const rows = [
				...[...state.running.values()].map((job) => jobRow(job, false)),
				...[...state.background.values()].map((job) => jobRow(job, true)),
			].sort((a, b) => a.id - b.id);
			try {
				pi.appendEntry<JobsCard>(JOBS_ENTRY, {
					rows,
					message: rows.length === 0 ? "No shell command is running or backgrounded." : undefined,
				});
			} catch {
				/* stale runtime after reload */
			}
		},
	});
}
