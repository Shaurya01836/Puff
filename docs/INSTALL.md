# Installing Puff (Windows)

Puff installs like any desktop app. You do not need the source code, Node or npm to run it.

## What you need first

| Need                                                                   | Why                                                                                               | Without it                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Docker Desktop**, running                                            | Puff's memory lives in FalkorDB, a graph database. Puff starts it in Docker for you (one button). | You can run FalkorDB yourself on port 6379 instead.                         |
| **At least one agent CLI**, signed in: `claude`, `codex` or `opencode` | These are the agents Puff drives.                                                                 | You can still add a project and explore its graph.                          |
| **git**                                                                | Agents work in separate git worktrees.                                                            | A folder that is not a git repository can be set up by Puff when you agree. |

Install the agent CLIs with npm and sign in once by running each one:

```bash
npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai
```

## Install

1. Download `Puff-Setup.exe` from the latest release (the Download button on the website goes there) and run it. It is a normal guided installer: pick the folder (the default is per user, so it needs no administrator rights) and finish.
2. Windows may show a SmartScreen "unknown publisher" warning, because the installer is not code-signed yet. Choose **More info**, then **Run anyway**.
3. Start **Puff** from the Start menu or the desktop shortcut.

## Updating

Run a newer installer. If Puff is already installed, Setup says so (which version, which folder), updates it **in the same folder**, and asks you to close Puff if it is open. It finds the folder in the registry, so it works wherever you first installed it. Your projects, settings and memory are kept, because they live in `~/.puff` and the database, not in the app folder. There is no automatic update yet.

## First run

- **Setup screen.** If the database is not reachable, Puff says so and shows what it found: whether Docker is installed and running, and which agent CLIs are on your PATH. **Start the database** runs FalkorDB in a Docker container named `puff-falkordb` (the first time downloads the image, a few minutes). If port 6379 is taken, Puff picks the next free port and remembers it in `~/.puff/.env`. Nothing is started until you press the button.
- **Agent tools.** The setup and welcome screens list each agent CLI with whether it is installed and signed in (asked of the CLI itself: `claude auth status`, `codex login status`). Next to a Claude Code or Codex that is not signed in there is a **Sign in** button: it starts the CLI's own sign-in, which opens your browser on the provider's page. If the page shows a one-time code, paste it into the box under the button. Puff never sees your password or token. OpenCode's sign-in asks which provider you use, so do that in a terminal (`opencode auth login`).
- **Welcome screen.** Press **Add a project…** and choose a folder. Puff checks it first (git, TypeScript or JavaScript files, a test command), tells you what will work, and indexes it.
- **Tasks** shows what each agent is doing: pick a task for its live steps, the graph's reason for its agent, and **Open in Codex** (or Claude Code, or OpenCode: the agent the task uses) to continue in that agent's own terminal. **Memory** lists what the team has learned. **Ask Puff** (Ctrl+K) talks to the project; **Run team** starts the agents.
- **A project whose check already fails** still runs: Puff notes the failures that were there and a task passes if it adds no new one. Landing your own work uses the same rule.
- **First run of 0.1.6 downloads a 30 MB language model** (once, in the background, to `~/.puff/models`) so similar failures are found by meaning. Without it Puff falls back to word matching; `PUFF_EMBED=off` turns it off.

## Where things are kept

| What                                                            | Where                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Your projects and which one is open                             | `~/.puff/projects.json`                                                         |
| Your own settings (database port)                               | `~/.puff/.env`                                                                  |
| Your own agent configuration, if you create one                 | `~/.puff/config.yaml` (`puff config init` writes a copy of the default to edit) |
| The default agent configuration, grammars and benchmark results | Inside the installed app (its `resources` folder)                               |
| The memory itself                                               | The `puff-falkordb` Docker volume, one graph per project (`puff_<project>`)     |

Uninstalling removes the app. It leaves `~/.puff` and the database volume alone, because that is your data.

## Build the installer yourself

Releases are built by GitHub Actions: pushing a tag such as `v0.1.6` runs `.github/workflows/release.yml`, which builds the installer on a Windows machine and attaches `Puff-Setup.exe` to the release. To build it on your own computer:

```bash
npm install
npm run package -w @puff/desktop            # the installer: apps/desktop/release/Puff-Setup.exe
npm run package:dir -w @puff/desktop        # an unpacked app folder only (faster, for testing)
```

The script (`apps/desktop/scripts/package.mjs`) builds the app, stages the built files and the few runtime packages in a temporary folder outside the repository, and runs electron-builder there. It stages outside the repository because electron-builder's dependency scan does not finish inside this monorepo, and it ships the three tree-sitter grammar files as plain resources because the `tree-sitter-wasms` package breaks that scan. Electron is pinned to an exact version for the same tool.

## Known limits

- Windows only; the installer is not code-signed.
- Updating means running a newer installer; there is no auto-update.
- One of Claude Code, Codex or OpenCode must be installed and signed in for the Ask Puff chat to answer plain sentences (pick which one in the panel header). Slash commands work without any. Claude Code is the most reliable at using Puff's tools; Codex and OpenCode work through a text protocol, and a weaker model may need a repeated request.
- Sign-in status is known for Claude Code and Codex; for OpenCode it shows as installed only.
- **Take over** opens the agent's own program in a terminal, so that program must be installed (and signed in to be useful). The first time Claude Code opens in a new task folder it asks whether to trust it, as it does anywhere. The plain terminal is PowerShell on Windows.
