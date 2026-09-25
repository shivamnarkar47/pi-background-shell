# pi-background-shell

Ctrl+B moves a running shell command in the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) into the background, then reports the result when it finishes — the same workflow as backgrounded shell commands in opencode v2.

Long `powershell`/`bash` calls no longer stall the turn: press Ctrl+B, keep working, and get a toast plus the full details (exit code, duration, output tail) delivered to the agent when the process exits.

## What it does

While the model is running a shell command:

- **Ctrl+B** releases the tool call immediately with a note that the command is still running, so the agent continues instead of blocking.
- The process keeps running — pressing **Escape** after backgrounding does *not* kill it.
- When the process exits, pi shows a **toast** and sends the agent a **user message** with the command, cwd, exit code, duration and the tail of its output.
- A footer status (`bg: #2`) tracks background jobs and clears as they finish.
- **Nothing over 20s blocks a turn.** A command still running after `AUTO_BACKGROUND_SECONDS` (20) is backgrounded automatically, with no keypress.
- The agent is told what a backgrounded command means: **do not re-run it, do not sleep or poll to wait for it, and end the turn if there is nothing else to do** — and it is given a `shell_jobs` tool to read a running command instead of guessing.
- While a job is backgrounded, the wrapper also refuses **second copies** of a command that is already running.
- `timeout` and sleep commands are **refused outright, always** — the tool has its own `timeout` parameter, and a shell `timeout` reports 124 instead of the real exit code.

When no command is running, Ctrl+B is passed through untouched, so its default "cursor left" behaviour is preserved.

## Install

### curl

```sh
curl -fsSL https://raw.githubusercontent.com/shivamnarkar47/pi-background-shell/main/install.sh | sh
```

The script downloads `background-shell.ts` into `~/.pi/agent/extensions/` (pass a different extensions directory as its first argument).

PowerShell on Windows (Windows 10+ ships `curl.exe`):

```powershell
New-Item -ItemType Directory -Force ~/.pi/agent/extensions | Out-Null
curl.exe -fsSL https://raw.githubusercontent.com/shivamnarkar47/pi-background-shell/main/background-shell.ts -o ~/.pi/agent/extensions/background-shell.ts
```

### Manual

Copy the extension into your pi agent directory:

```powershell
# PowerShell
Copy-Item background-shell.ts ~/.pi/agent/extensions/
```

```sh
# bash / zsh
cp background-shell.ts ~/.pi/agent/extensions/
```

Then restart pi or run `/reload`. No build step — pi loads TypeScript extensions directly with jiti.

## Uninstall

Delete the file and run `/reload`:

```sh
rm ~/.pi/agent/extensions/background-shell.ts
```

## How it works

pi's extension API can register tools and raw terminal input listeners, which is all this needs:

- The built-in `bash` and `powershell` tools are re-registered with their original schema, prompt and renderers, but execution goes through a wrapper (`BashOperations`) that spawns the child with its own `AbortController`. The tool call's abort signal is only forwarded until detach, which is why a backgrounded command survives both the turn and a later Escape.
- A `ctx.ui.onTerminalInput` listener claims Ctrl+B (`\x02`, plus kitty CSI-u `ESC [ 98 ; 5 u`) *only* while a shell command is awaiting its result; otherwise the key falls through to the editor.
- On completion the wrapper reports through `ctx.ui.notify` and `pi.sendUserMessage(..., { deliverAs: "steer" })`.

Job state lives in a `globalThis` registry, so `/reload` (which re-imports the extension) does not orphan a command that was backgrounded before the reload.

## Commands

| Command | What it does |
| --- | --- |
| `/background` | Renders a card listing every running (`run`) and backgrounded (`bg`) shell command: id, elapsed time, command, and the last line of output. |
| `/background kill <id>` | Kills that job (running or backgrounded) and reports the cancellation to you and the agent. |
| `/background kill all` | Kills every backgrounded job. |

```
⏱ Background shell  2 commands
bg   #3      2m14s   npm run build                     … compiled in 41.2s
run  #5        1.2s  uv run pytest tests -x
kill one: /background kill <id>  ·  all: /background kill all
```

The card is appended to the stream, not to the model's context. Killing a job aborts the same controller that owns its child process, so the process tree is torn down and the normal completion report fires with `cancelled by the user` — the agent is told the command was cancelled rather than left waiting.

## Shell resolution

The wrapper never picks a shell. It delegates to pi's own `createLocalBashOperations({ shellPath })` and `createLocalPowerShellOperations()`, built from the same settings the built-in tools use (`SettingsManager.getShellPath()`, `getShellCommandPrefix()`), and pi re-resolves the shell on **every** exec:

| Tool | Resolution |
| --- | --- |
| `bash` | `shellPath` setting → Git Bash in known locations → `bash` on PATH → `sh` |
| `powershell` | `pwsh.exe` on PATH → `powershell.exe` (Windows only) |

Detaching changes exactly two things — when the tool call returns, and whether the turn's abort signal still reaches the child. The process, its shell, cwd and environment are untouched, so a backgrounded run is indistinguishable from a foreground one. The smoke test asserts this: our `bash`/`powershell` tools resolve the same shell as pi's built-in definitions, and a backgrounded job's completion report contains the same shell identity as a foreground run.

> On Windows without Git for Windows, `bash` resolves to the WSL launcher (`C:\Windows\System32\bash.exe`), so `bash` commands run under WSL — that is pi's default, and the backgrounded job stays in WSL too.

## The rule the agent is given

Backgrounding only helps if the agent stops waiting on the command, so the rule is stated twice:

1. In the tool result itself, the moment a command is backgrounded:
   > `[pi] Command moved to background (job #27). It is still running; pi will message you with the exit code and output when it finishes. Do not re-run it, and do not sleep, Wait-Sleep or poll to wait for it. If you have nothing else to do, end your turn now.`
2. As a `## Backgrounded shell commands` section appended to the system prompt on every turn via `before_agent_start`, so it also holds on turns where nothing was backgrounded.

Both say: never re-run a backgrounded command, never wait for it (`sleep`, `Start-Sleep`, `Wait-Sleep`, `timeout`, poll loops), do other work if there is any, and otherwise end the turn — the result arrives on its own.

The same text can be pinned in `~/.pi/agent/AGENTS.md` (pi's user-instructions context file) if you want the rule to hold even when the extension is not installed.

## Auto-background after 20s

You do not have to press Ctrl+B. A command still running after `AUTO_BACKGROUND_SECONDS` (20) is detached automatically — the tool call returns, the turn continues, and the completion report arrives when the process exits:

```
[pi] Command still running after 20s, so it was moved to the background automatically (job #4). …
```
```
powershell #4 still running after 20s - moved to background
```

The completion report says so too (`…, auto-backgrounded after 20s`), so the model can tell the difference between a command it backgrounded deliberately and one the timer caught. Edit the constant at the top of `background-shell.ts` to change the threshold.

## The `shell_jobs` tool

Blocking the re-run only helps if the agent has another way to see what a running command is doing, so the extension registers a small model-facing tool:

| Call | Result |
| --- | --- |
| `shell_jobs` / `{action: "list"}` | Every job: `#id`, running/background (auto), elapsed, command |
| `{action: "output", id}` | The job's output so far, its cwd, and a reminder that it is still running |
| `{action: "kill", id}` | Kills the job |

It closes the incentive that produced this failure mode: before, the only way to see a live command's output was to start it again.

## What gets refused

Two rules are enforced in the wrapper, before anything is spawned: the tool call returns an error and you get a toast.

### `timeout` and sleep — always, not just while something is pending

`timeout 400 uv run pytest …` is refused even with no background job at all:

```
[pi] refused: timeout 400 uv run pytest … wraps a command in `timeout`. Pass the tool's own timeout
parameter instead - a shell `timeout` reports exit code 124 and hides the real failure. If you are
waiting for something, do other work or end your turn.
```

That is the point of banning it: the tool already has a `timeout` parameter, and a shell-level `timeout` reports 124 instead of the real exit code, so a failing test ends up looking like a slow one.

Sleep and wait constructs get the same treatment and the same advice:

| Refused | Example |
| --- | --- |
| `timeout` / `gtimeout` | `timeout 400 …`, `timeout /t 30` |
| `sleep` / `tsleep` | `sleep 280` |
| PowerShell wait cmdlets | `Start-Sleep 30`, `Wait-Sleep`, `Wait-Event` |
| ping-as-sleep | `ping -n 11 127.0.0.1` |
| one-liner interpreter sleeps | `time.sleep(60)`, `setTimeout(done, 60000)` |

Still allowed: `ping -c 1 host` (a single connectivity check), and anything else — a command that genuinely needs a pause should express the *work*, not the waiting.

Need one anyway? Set `PI_ALLOW_WAIT_COMMANDS=1` before starting pi and both rules stand down (the model-facing instructions still apply).

### A second copy of a command that is already running

The incident that prompted this: after backgrounding `python proto_gee.py`, the agent re-ran it as `timeout 300 … > /tmp/gee_out.txt; sed -n …` — two concurrent copies of the same script. Commands are reduced to the part that decides what runs (`cd …&&`, `timeout N`, redirections and a trailing `| sed`/`Select-String` are stripped) and an exact match against a live job is refused:

```
[pi] refused: background job #69 is already running this command (PYTHONIOENCODING=utf-8 python
proto_gee.py). Do not start a second copy. Read it with shell_jobs (action "output", id 69) or
kill it with action "kill"; the full result is delivered automatically when it finishes.
```

Different arguments (`python proto_gee.py --dry-run`) are a different command and stay allowed. Both matchers are regex heuristics: a wait or a duplicate hidden inside a script the agent wrote itself is not detected.

## Behaviour notes

- Applies to the agent's `bash` and `powershell` tool calls only — not to `!` commands you type yourself.
- Honours your `shellPath` and `shellCommandPrefix` settings.
- Ctrl+B is consumed while a command runs, which takes precedence over any `tui.editor.cursorLeft` binding for that moment.
- Backgrounded commands are tracked by pi and killed when pi exits; run `nohup`/detached processes inside the command if it must outlive the session.
- The command's output is capped in memory (40 000 chars kept, last 4 000 included in the report).

## Test

Both need an installed pi:

```sh
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent node tests/smoke.mjs            # ~25s
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent node tests/auto-background.mjs   # ~30s
```

`tests/smoke.mjs` loads the extension through pi's own loader and covers a normal run, shell resolution against pi's built-ins, Ctrl+B, the wait and duplicate refusals, `/background`, `shell_jobs` and the completion reports.

`tests/auto-background.mjs` is separate on purpose: it has to outlast the 20-second threshold, so it runs once and checks that the timer detaches a command with no keypress, that the note and toast say it was automatic, and that the report says `auto-backgrounded after 20s`.

`PI_PACKAGE_DIR` may point at the package root or its `dist` folder; it can be omitted when `@earendil-works/pi-coding-agent` is resolvable from the repo.

## License

[MIT](LICENSE)
