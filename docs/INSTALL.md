# Installing Puff (Windows)

Puff installs like any desktop app. You do not need the source code, Node or npm to run it.

## What you need first

| Need | Why | Without it |
|---|---|---|
| **Docker Desktop**, running | Puff's memory lives in FalkorDB, a graph database. Puff starts it in Docker for you (one button). | You can run FalkorDB yourself on port 6379 instead. |
| **At least one agent CLI**, signed in: `claude`, `codex` or `opencode` | These are the agents Puff drives. | You can still add a project and explore its graph. |
| **git** | Agents work in separate git worktrees. | A folder that is not a git repository can be set up by Puff when you agree. |

Install the agent CLIs with npm and sign in once by running each one:

```bash
npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai
```

## Install

1. Run `Puff-Setup-0.1.0.exe`. It is a normal guided installer: pick the folder (the default is per user, so it needs no administrator rights) and finish.
2. Windows may show a SmartScreen "unknown publisher" warning, because the installer is not code-signed yet. Choose **More info**, then **Run anyway**.
3. Start **Puff** from the Start menu or the desktop shortcut.

## First run

- **Setup screen.** If the database is not reachable, Puff says so and shows what it found: whether Docker is installed and running, and which agent CLIs are on your PATH. **Start the database** runs FalkorDB in a Docker container named `puff-falkordb` (the first time downloads the image, a few minutes). If port 6379 is taken, Puff picks the next free port and remembers it in `~/.puff/.env`. Nothing is started until you press the button.
- **Welcome screen.** Press **Add a project…** and choose a folder. Puff checks it first (git, TypeScript or JavaScript files, a test command), tells you what will work, and indexes it.
- **Ask Puff** (Ctrl+K) talks to the project; **Run team** starts the agents.

## Where things are kept

| What | Where |
|---|---|
| Your projects and which one is open | `~/.puff/projects.json` |
| Your own settings (database port) | `~/.puff/.env` |
| Your own agent configuration, if you create one | `~/.puff/config.yaml` (`puff config init` writes a copy of the default to edit) |
| The default agent configuration, grammars and benchmark results | Inside the installed app (its `resources` folder) |
| The memory itself | The `puff-falkordb` Docker volume, one graph per project (`puff_<project>`) |

Uninstalling removes the app. It leaves `~/.puff` and the database volume alone, because that is your data.

## Build the installer yourself

```bash
npm install
npm run package -w @puff/desktop            # the installer: apps/desktop/release/Puff-Setup-<version>.exe
npm run package:dir -w @puff/desktop        # an unpacked app folder only (faster, for testing)
```

The script (`apps/desktop/scripts/package.mjs`) builds the app, stages the built files and the few runtime packages in a temporary folder outside the repository, and runs electron-builder there. It stages outside the repository because electron-builder's dependency scan does not finish inside this monorepo, and it ships the three tree-sitter grammar files as plain resources because the `tree-sitter-wasms` package breaks that scan. Electron is pinned to an exact version for the same tool.

## Known limits

- Windows only; the installer is not code-signed.
- Updating means running a newer installer; there is no auto-update.
- Claude Code must be installed and signed in for the Ask Puff chat to answer plain sentences. Slash commands work without it.
- The setup screen shows whether each agent CLI is installed, not whether it is signed in.
