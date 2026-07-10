![agent-wizard](assets/banner.png)

# agent-wizard

Terminal UI for managing Claude Code subagents (project, user, and plugin scopes). Plain Node script, no npm dependencies — uses only built-in `fs`/`path`/`os`/`readline`/`child_process`.

Real arrow-key/Enter navigation needs a program that owns the terminal directly, which Claude Code slash commands/skills can't do (they're just text expanded into the conversation). So this runs as a standalone script instead.

![agent-wizard screenshot](screenshot.svg)

Every screen opens with a header box — title on the top border, `cwd` on the bottom border, and the user agents dir plus up to the last 4 [`RELEASE_NOTES.md`](RELEASE_NOTES.md) entries (dates stripped, one bullet per line) in between, read once at startup. Same idea as Claude Code's own startup banner, just redrawn on every frame instead of shown once, since this TUI already repaints the whole screen on every keypress.

On terminals that speak iTerm2's or Kitty's inline-image protocol, that header box also draws the wizard from `assets/logo.png` on its left edge (content shifts right, divider in between), with the top border's "✦ Agent Wizard" title shifting right along with it so it no longer sits above the image. Falls back to the title back at the left edge and no image on terminals it doesn't recognize — narrow terminals, tmux/screen, or plain unrecognized `TERM`/`TERM_PROGRAM`. Set `AGENT_WIZARD_NO_LOGO=1` to force that fallback anywhere.

Same terminals also get the wizard mid-spell (`assets/spell.png`) popping up at a random spot on screen while you answer "+ New agent"'s questions — a new random spot each question, purely decorative.

## Install

**macOS/Linux:**

```bash
./install.sh
```

One script, works on both. Symlinks `agent-wizard.js` to `~/.local/bin/lsagents` (override with `INSTALL_DIR=/some/dir ./install.sh`). Add that dir to `PATH` if the installer warns it's missing (it points at `~/.zshrc` or `~/.bashrc`/`~/.bash_profile` depending on your `$SHELL`), then run `lsagents`.

**Windows (PowerShell):**

```powershell
.\install.ps1
```

Symlinks into `%USERPROFILE%\bin\lsagents.cmd` (override with `.\install.ps1 -InstallDir "C:\tools\bin"`). Real symlinks need Developer Mode or an elevated shell — without either, it falls back to a `lsagents.cmd` shim that calls `node` on the script directly, working the same either way. Add the install dir to `PATH` (`setx PATH "<dir>;%PATH%"`, then restart the terminal) if warned, then run `lsagents`.

Without installing, run directly:

```bash
node agent-wizard.js
# or, macOS/Linux only
chmod +x agent-wizard.js && ./agent-wizard.js
```

## Update

```bash
lsagents --update
```

Runs `git pull` in this checkout. Since the installed binary is a symlink (or, on Windows without Developer Mode/admin, a shim pointing straight at `agent-wizard.js` — see install.ps1), pulling is all that's needed; no need to re-run the installer. Equivalent to `git pull` directly from the `agent-wizard` directory. Doesn't require a TTY, so it works piped or scripted.

## Version

```bash
lsagents --version   # or -v
```

Prints an estimated semver and exits — no TTY needed. There's no `package.json`/tag to read a real version from, so it's *derived*: walk this checkout's git log oldest-to-newest and bump major/minor/patch by each commit's conventional-commit prefix (`feat` → minor, `fix`/`perf` → patch, a breaking `!` or `BREAKING CHANGE` → major once past `0.x`, minor while still `0.x`; everything else, e.g. `chore`/`docs`/`refactor`, doesn't bump). A `-dev` suffix is appended if the working tree has uncommitted changes. Same estimate shows in the header box title (`✦ Agent Wizard vX.Y.Z`) on the main screen. See `lib/version.js`.

> Renamed from `agents-wizard` (plural) on 2026-07-08 — filenames, the `~/.claude/agent-wizard/config.json` config path, and on-screen titles all changed. If your installed `lsagents` still points at a file called `agents-wizard.js`, re-run the installer after pulling; old bookmarks/tracked-agent config migrates automatically on first run.

## Controls

| Key | Action |
|---|---|
| `←` / `→` | switch tabs (Project / User / Plugin) |
| `↑` / `↓` | move selection (scrolls to keep selection visible) |
| `Enter` | on an agent: launch it (`claude --agent <name>`, foreground); on "+ New agent": create one; in Project bookmarks mode: enter that project's agent list |
| `v` | view selected agent's raw file (any tab, incl. Plugin) |
| `c` | copy selected agent's file into another project's `.claude/agents/` (any tab, incl. Plugin — not the bookmarks list itself). Pick cwd, a bookmark, or type a new path; confirms before overwriting a same-named file at the destination |
| `e` | edit selected agent with `$EDITOR` (Project/User only) |
| `x` | delete selected agent, after retyping its name to confirm (Project/User only). On a tracked plugin agent (shown in User), untracks instead — the plugin file itself is never touched |
| `u` | (Plugin tab) track/untrack the selected agent into the User tab — see Scopes below |
| `b` | (Project tab) jump between cwd and bookmarks |
| `Esc` | (Project tab, inside a bookmark project) back to bookmarks list |
| `d` | (Project tab, bookmarks list) remove highlighted bookmark |
| `/` | search every scope at once (Project cwd + every bookmarked project + User + Plugin) by name, description, or project/plugin label; `Enter` launches a result, `Tab` opens a menu for it (Launch/View/Edit/Delete/Copy, or Launch/View/Track/Copy for an untracked plugin result) — no bare-letter or Ctrl hotkeys here, since letters are needed for typing the query and Ctrl combos like Ctrl+V are often claimed by the terminal/OS as Paste |
| `?` | help on writing a good agent (name/description/tools/model/system-prompt) |
| `q` | quit (main list); back (menus/viewer/help) |

## Scopes

- **Project** — three states:
  - `cwd`: `<cwd>/.claude/agents/`, cwd captured once at startup (no walking up to parent dirs). Writable.
  - `bookmarks`: flat list of remembered project folders (`~/.claude/agent-wizard/config.json`). `d` removes a bookmark (non-destructive, no confirmation).
  - `bookmark-project`: one bookmarked project's agents, same writable list as cwd. `Esc` → bookmarks list, `b` → cwd.
  - `b` resumes whichever bookmark state you last left; backing all the way out forgets it, so the next `b` from cwd goes to the list.
- **User** — `~/.claude/agents/` (personal, all projects). Writable. Also shows any plugin agents you've "tracked" (see Plugin below), mixed into the same list — they're real rows here, with the same Enter/`v`/`e`/`x`.
- **Plugin** — `~/.claude/plugins/marketplaces/**/agents/*.md`. All agents from plugins. Some plugins may include an agent with same name as another. Differentiated with a column that shows plugin it belongs to. Read-only in this tab (`e`/`x` do nothing here) — but `u` tracks/untracks the highlighted agent into the User tab (marked `★` here once tracked), for when you own that plugin/marketplace checkout and want to edit it directly. Tracking only remembers the file path (`~/.claude/agent-wizard/config.json`, `trackedPluginAgents`) — it does **not** copy the file into `~/.claude/agents/`, so editing a tracked agent from the User tab edits the plugin's real file in place. Only do this for a plugin you own or are developing; untracking (`x` on the linked row, or `u` again from the Plugin tab) just forgets the pointer and never touches the file.

## Creating an agent

"+ New agent" asks for role, seniority, and general tasks (not a raw description), drafts a trigger description via one tool-disabled `claude -p` call, then you choose how to finish the file. The tasks and guidelines questions are multi-line: `Enter` opens `$EDITOR`/`$VISUAL` (nano by default) on a temp file seeded with any prior answer — write as much as you want, save & close to continue; `#`-prefixed comment lines are stripped before that text gets sent to claude.

- **Auto-draft with `claude -p`** — a second tool-disabled call using `add_agent.md` (same directory) as system prompt, writing the complete file non-interactively.
- **Open interactive claude session** — a real interactive `claude` session in your terminal, full tool access, using `finish_agent_interactive.md` as system prompt.
- **Skip** — writes the manual template directly.

Falls back to the manual template if `claude` CLI is missing, the `-p` call fails, or an interactive session ends without writing the file. `$EDITOR` opens afterward either way, to review/adjust before it's final.

## Files

- `agent-wizard.js` — the script
- `assets/logo.png` — small wizard-only crop drawn into the header box on terminals with inline-image support (see `agent-wizard.js`'s "Inline image logo" section)
- `assets/spell.png` — wizard mid-spell crop, popped up at a random spot during "+ New agent"'s questions on the same terminals
- `assets/banner.png` — full logo (wizard + wordmark), used at the top of this README
- `RELEASE_NOTES.md` — hand-maintained changelog; the TUI's header box reads its first 4 lines on startup. Add an entry here alongside any user-visible change
- `lib/version.js` — estimates semver from git log conventional-commit prefixes, backs `--version`/`-v` and the header box's version display
- `install.sh` — macOS/Linux installer (symlinks into a bin dir on `PATH`)
- `install.ps1` — Windows installer (symlink, or shim fallback without Developer Mode/admin)
- `add_agent.md` — system prompt for the non-interactive auto-draft path
- `finish_agent_interactive.md` — system prompt for the interactive finish path
- `lsagents` — dev convenience shim (hardcoded path, not what `install.sh` produces)
