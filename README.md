# pi-background-shell

Ctrl+B moves a running shell command in the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) into the background, then reports the result when it finishes — the same workflow as backgrounded shell commands in opencode v2.

Long `powershell`/`bash` calls no longer stall the turn: press Ctrl+B, keep working, and get a toast plus the full details (exit code, duration, output tail) delivered to the agent when the process exits.

## What it does

While the model is running a shell command:

- **Ctrl+B** releases the tool call immediately with a note that the command is still running, so the agent continues instead of blocking.
- The process keeps running — pressing **Escape** after backgrounding does *not* kill it.
- When the process exits, pi shows a **toast** and sends the agent a **user message** with the command, cwd, exit code, duration and the tail of its output.
- A footer status (`bg: #2`) tracks background jobs and clears as they finish.
- The agent is told what a backgrounded command means: **do not re-run it, do not sleep or poll to wait for it, and end the turn if there is nothing else to do.**

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

## The rule the agent is given

Backgrounding only helps if the agent stops waiting on the command, so the rule is stated twice:

1. In the tool result itself, the moment a command is backgrounded:
   > `[pi] Command moved to background (job #27). It is still running; pi will message you with the exit code and output when it finishes. Do not re-run it, and do not sleep, Wait-Sleep or poll to wait for it. If you have nothing else to do, end your turn now.`
2. As a `## Backgrounded shell commands` section appended to the system prompt on every turn via `before_agent_start`, so it also holds on turns where nothing was backgrounded.

Both say: never re-run a backgrounded command, never wait for it (`sleep`, `Start-Sleep`, `Wait-Sleep`, `timeout`, poll loops), do other work if there is any, and otherwise end the turn — the result arrives on its own.

The same text can be pinned in `~/.pi/agent/AGENTS.md` (pi's user-instructions context file) if you want the rule to hold even when the extension is not installed.

## Behaviour notes

- Applies to the agent's `bash` and `powershell` tool calls only — not to `!` commands you type yourself.
- Honours your `shellPath` and `shellCommandPrefix` settings.
- Ctrl+B is consumed while a command runs, which takes precedence over any `tui.editor.cursorLeft` binding for that moment.
- Backgrounded commands are tracked by pi and killed when pi exits; run `nohup`/detached processes inside the command if it must outlive the session.
- The command's output is capped in memory (40 000 chars kept, last 4 000 included in the report).

## Test

`tests/smoke.mjs` loads the extension through pi's own loader and checks a normal run, Ctrl+B backgrounding and the completion report. It needs an installed pi:

```sh
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent node tests/smoke.mjs
```

`PI_PACKAGE_DIR` may point at the package root or its `dist` folder; it can be omitted when `@earendil-works/pi-coding-agent` is resolvable from the repo.

## License

[MIT](LICENSE)
