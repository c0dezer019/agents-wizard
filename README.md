# agents-wizard

Terminal UI for managing Claude Code subagents (project, user, and plugin scopes). Plain Node script, no npm dependencies — uses only built-in `fs`/`path`/`os`/`readline`/`child_process`.

Real arrow-key/Enter navigation needs a program that owns the terminal directly, which Claude Code slash commands/skills can't do (they're just text expanded into the conversation). So this runs as a standalone script instead.

## Install

**macOS/Linux:**

```bash
./install.sh
```

One script, works on both. Symlinks `agents-wizard.js` to `~/.local/bin/lsagents` (override with `INSTALL_DIR=/some/dir ./install.sh`). Add that dir to `PATH` if the installer warns it's missing (it points at `~/.zshrc` or `~/.bashrc`/`~/.bash_profile` depending on your `$SHELL`), then run `lsagents`.

**Windows (PowerShell):**

```powershell
.\install.ps1
```

Symlinks into `%USERPROFILE%\bin\lsagents.cmd` (override with `.\install.ps1 -InstallDir "C:\tools\bin"`). Real symlinks need Developer Mode or an elevated shell — without either, it falls back to a `lsagents.cmd` shim that calls `node` on the script directly, working the same either way. Add the install dir to `PATH` (`setx PATH "<dir>;%PATH%"`, then restart the terminal) if warned, then run `lsagents`.

Without installing, run directly:

```bash
node agents-wizard.js
# or, macOS/Linux only
chmod +x agents-wizard.js && ./agents-wizard.js
```

## Update

```bash
lsagents --update
```

Runs `git pull` in this checkout. Since the installed binary is a symlink (or, on Windows without Developer Mode/admin, a shim pointing straight at `agents-wizard.js` — see install.ps1), pulling is all that's needed; no need to re-run the installer. Equivalent to `git pull` directly from the `agents-wizard` directory. Doesn't require a TTY, so it works piped or scripted.

## Controls

| Key | Action |
|---|---|
| `←` / `→` | switch tabs (Project / User / Plugin) |
| `↑` / `↓` | move selection (scrolls to keep selection visible) |
| `Enter` | on an agent: launch it (`claude --agent <name>`, foreground); on "+ New agent": create one; in Project bookmarks mode: enter that project's agent list |
| `v` | view selected agent's raw file (any tab, incl. Plugin) |
| `e` | edit selected agent with `$EDITOR` (Project/User only) |
| `x` | delete selected agent, after retyping its name to confirm (Project/User only). On a tracked plugin agent (shown in User), untracks instead — the plugin file itself is never touched |
| `u` | (Plugin tab) track/untrack the selected agent into the User tab — see Scopes below |
| `b` | (Project tab) jump between cwd and bookmarks |
| `Esc` | (Project tab, inside a bookmark project) back to bookmarks list |
| `d` | (Project tab, bookmarks list) remove highlighted bookmark |
| `/` | search every scope at once (Project cwd + every bookmarked project + User + Plugin) by name, description, or project/plugin label; `Enter` launches a result, `Tab` opens a menu for it (Launch/View/Edit/Delete, or Launch/View/Track for an untracked plugin result) — no bare-letter or Ctrl hotkeys here, since letters are needed for typing the query and Ctrl combos like Ctrl+V are often claimed by the terminal/OS as Paste |
| `?` | help on writing a good agent (name/description/tools/model/system-prompt) |
| `q` | quit (main list); back (menus/viewer/help) |

## Scopes

- **Project** — three states:
  - `cwd`: `<cwd>/.claude/agents/`, cwd captured once at startup (no walking up to parent dirs). Writable.
  - `bookmarks`: flat list of remembered project folders (`~/.claude/agents-wizard/config.json`). `d` removes a bookmark (non-destructive, no confirmation).
  - `bookmark-project`: one bookmarked project's agents, same writable list as cwd. `Esc` → bookmarks list, `b` → cwd.
  - `b` resumes whichever bookmark state you last left; backing all the way out forgets it, so the next `b` from cwd goes to the list.
- **User** — `~/.claude/agents/` (personal, all projects). Writable. Also shows any plugin agents you've "tracked" (see Plugin below), mixed into the same list — they're real rows here, with the same Enter/`v`/`e`/`x`.
- **Plugin** — `~/.claude/plugins/marketplaces/**/agents/*.md`. All agents from plugins. Some plugins may include an agent with same name as another. Differentiated with a column that shows plugin it belongs to. Read-only in this tab (`e`/`x` do nothing here) — but `u` tracks/untracks the highlighted agent into the User tab (marked `★` here once tracked), for when you own that plugin/marketplace checkout and want to edit it directly. Tracking only remembers the file path (`~/.claude/agents-wizard/config.json`, `trackedPluginAgents`) — it does **not** copy the file into `~/.claude/agents/`, so editing a tracked agent from the User tab edits the plugin's real file in place. Only do this for a plugin you own or are developing; untracking (`x` on the linked row, or `u` again from the Plugin tab) just forgets the pointer and never touches the file.

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
- `lsagents` — dev convenience shim (hardcoded path, not what `install.sh` produces)
