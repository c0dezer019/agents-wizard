# agents-wizard

Terminal UI for managing Claude Code subagents (project, user, and plugin scopes). Plain Node script, no npm dependencies — uses only built-in `fs`/`path`/`os`/`readline`/`child_process`.

Real arrow-key/Enter navigation needs a program that owns the terminal directly, which Claude Code slash commands/skills can't do (they're just text expanded into the conversation). So this runs as a standalone script instead.

## Install

**macOS/Linux:**

```bash
./install.sh
```

One script, works on both. Symlinks `agents-wizard.js` to `~/.local/bin/wizard` (override with `INSTALL_DIR=/some/dir ./install.sh`). Add that dir to `PATH` if the installer warns it's missing (it points at `~/.zshrc` or `~/.bashrc`/`~/.bash_profile` depending on your `$SHELL`), then run `wizard`.

**Windows (PowerShell):**

```powershell
.\install.ps1
```

Symlinks into `%USERPROFILE%\bin\wizard.cmd` (override with `.\install.ps1 -InstallDir "C:\tools\bin"`). Real symlinks need Developer Mode or an elevated shell — without either, it falls back to a `wizard.cmd` shim that calls `node` on the script directly, working the same either way. Add the install dir to `PATH` (`setx PATH "<dir>;%PATH%"`, then restart the terminal) if warned, then run `wizard`.

Without installing, run directly:

```bash
node agents-wizard.js
# or, macOS/Linux only
chmod +x agents-wizard.js && ./agents-wizard.js
```

## Controls

| Key | Action |
|---|---|
| `←` / `→` | switch tabs (Project / User / Plugin) |
| `↑` / `↓` | move selection (scrolls to keep selection visible) |
| `Enter` | on an agent: launch it (`claude --agent <name>`, foreground); on "+ New agent": create one; in Project bookmarks mode: enter that project's agent list |
| `v` | view selected agent's raw file (any tab, incl. Plugin) |
| `e` | edit selected agent with `$EDITOR` (Project/User only) |
| `x` | delete selected agent, after retyping its name to confirm (Project/User only) |
| `b` | (Project tab) jump between cwd and bookmarks |
| `Esc` | (Project tab, inside a bookmark project) back to bookmarks list |
| `d` | (Project tab, bookmarks list) remove highlighted bookmark |
| `?` | help on writing a good agent (name/description/tools/model/system-prompt) |
| `q` | quit (main list); back (menus/viewer/help) |

## Scopes

- **Project** — three states:
  - `cwd`: `<cwd>/.claude/agents/`, cwd captured once at startup (no walking up to parent dirs). Writable.
  - `bookmarks`: flat list of remembered project folders (`~/.claude/agents-wizard/config.json`). `d` removes a bookmark (non-destructive, no confirmation).
  - `bookmark-project`: one bookmarked project's agents, same writable list as cwd. `Esc` → bookmarks list, `b` → cwd.
  - `b` resumes whichever bookmark state you last left; backing all the way out forgets it, so the next `b` from cwd goes to the list.
- **User** — `~/.claude/agents/` (personal, all projects). Writable.
- **Plugin** — always empty by design. Plugin caches under `~/.claude/plugins/cache/` keep orphaned copies for ~7 days after updates, so it's not a reliable "what's installed" source and is excluded rather than shown unreliably.

## Creating an agent

"+ New agent" asks for role, seniority, and general tasks (not a raw description), drafts a trigger description via one tool-disabled `claude -p` call, then you choose how to finish the file:

- **Auto-draft with `claude -p`** — a second tool-disabled call using `add_agent.md` (same directory) as system prompt, writing the complete file non-interactively.
- **Open interactive claude session** — a real interactive `claude` session in your terminal, full tool access, using `finish_agent_interactive.md` as system prompt.
- **Skip** — writes the manual template directly.

Falls back to the manual template if `claude` CLI is missing, the `-p` call fails, or an interactive session ends without writing the file. `$EDITOR` opens afterward either way, to review/adjust before it's final.

## Files

- `agents-wizard.js` — the script
- `install.sh` — macOS/Linux installer (symlinks into a bin dir on `PATH`)
- `install.ps1` — Windows installer (symlink, or shim fallback without Developer Mode/admin)
- `add_agent.md` — system prompt for the non-interactive auto-draft path
- `finish_agent_interactive.md` — system prompt for the interactive finish path
