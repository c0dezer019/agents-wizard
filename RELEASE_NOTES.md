# Release Notes

Newest first, one line per change: `- YYYY-MM-DD: what changed`. The TUI's
header box reads the first 4 lines here on startup (see
`getRecentReleaseNotes` in `agent-wizard.js`) — add an entry here as part of
any user-visible change, same turn as the code/README update, so the header
stays accurate.

- 2026-07-13: Update checker now fires on new tagged releases instead of every push to the branch — fetches tags, then flags update-available only if the latest local tag isn't yet an ancestor of `HEAD` (`git merge-base --is-ancestor`). Also fixed it (and `--update`'s `git pull`) silently never firing on checkouts without upstream tracking configured, by resolving `origin/<branch>` explicitly instead of relying on `@{u}`.
- 2026-07-13: User tab now detects the current project's stack (`package.json` deps, `requirements.txt`/`pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `Dockerfile`, etc.) and, when it finds a mix, splits agents into a "recommended agents:" section (name/description matches detected stack keywords) and an "others:" section beneath it. Falls back to the flat list when nothing's detected or every agent lands in the same bucket. Section headers are inert (`↑`/`↓` skip over them). See `lib/detect.js`.
- 2026-07-10: `lsagents --version` (or `-v`) prints an estimated semver, derived from conventional-commit prefixes (`feat`/`fix`/`perf`/breaking `!`) walked across this checkout's git log — no `package.json` or tags needed. Same version now shows in the header box title (`✦ Agent Wizard vX.Y.Z`, with a `-dev` suffix when the working tree has uncommitted changes). See `lib/version.js`.
- 2026-07-10: "+ New agent"'s tasks/guidelines questions now open `$EDITOR`/`$VISUAL` (nano by default) on a temp file for real multi-line input instead of a single-line prompt — same editor path as `e` (edit agent), seeded with any prior answer, comment lines (`#`) stripped before being sent to claude for description/file generation.
- 2026-07-10: "+ New agent" now asks a "Guidelines or restrictions?" question (optional, after tasks) that gets woven into the drafted system prompt (auto-draft, interactive, and manual-template paths all use it).
- 2026-07-10: Text prompts (name/role/seniority/tasks/guidelines) support real cursor editing — ←/→/Home/End move the cursor, typed chars insert at cursor, Backspace/Delete act at cursor, instead of only appending/trimming from the end.
- 2026-07-10: "+ New agent" navigation overhaul: `Esc` now cancels the whole create flow outright from any step (name, role, seniority, tasks, guidelines, finish-choice menu); `Shift+Tab` steps back to the previous question instead, prefilled with what you'd typed there, chaining all the way back to name. Also fixed a bug where escaping the finish-choice menu silently fell through to the manual template instead of cancelling.
- 2026-07-10: Spell flourish (`assets/spell.png`) is now confined to the bottom-most portion of the terminal (never overlaps the question text above it) and alternates left/right each question instead of landing at a random spot.
- 2026-07-08: "+ New agent" now shows the wizard mid-spell (`assets/spell.png`) at a random spot on screen for each question (name/role/seniority/tasks/finish-choice), on the same terminals the header logo shows on — pure flourish, one fresh random spot per question, no layout impact.
- 2026-07-08: Header box now draws a small pixel-art wizard icon (`assets/logo.png`) on its left edge on terminals that speak iTerm2's or Kitty's inline-image protocol, with the "✦ Agent Wizard" title (still on the top border) shifted right past it — falls back to the title at the left edge and no image everywhere else (including narrow terminals, tmux/screen, or `AGENT_WIZARD_NO_LOGO=1`). Also added `assets/banner.png` as the README's top image.
- 2026-07-08: Logo is `✦` again, with an env-var-based `supportsUnicode()` heuristic falling back to plain `*` on terminals unlikely to render it — no npm dep, matches this script's zero-dependency rule.
- 2026-07-08: Cleaned up the header box — recent-changes entries are now short, date-free bullets instead of a hanging-indent block, and `cwd` moved to the bottom border (mirroring the title on top). Also fixed a real alignment bug: a long `cwd` label wasn't being truncated to fit narrow terminals, blowing out the border width.
- 2026-07-08: Renamed project from `agents-wizard` (plural) to `agent-wizard` — script file, `~/.claude/agent-wizard/config.json` config path (auto-migrates from the old location on first run), and on-screen titles. `agents-wizard.js`/old repo/folder names are unaffected by this change; see README.
- 2026-07-08: Fixed the header box's right-edge alignment (the top border was rendering 1 character longer than every other line) and added a ✦ logo glyph next to the title.
- 2026-07-08: Header box now shows the last 4 entries from this file instead of the tool's own single `git log` line.
- 2026-07-08: Added a bordered header box (project/user dirs, recent changes) plus a `screenshot.svg` TUI mockup for the README.
- 2026-07-07: Copy an agent's file into another project via the `c` hotkey (Project/User/Plugin tabs) or the `/` search menu's "Copy to project…" action.
- 2026-07-07: `lsagents --update` pulls the latest agents-wizard checkout in place.
- 2026-07-07: Live search (`/`) across every scope at once, plus tracking a plugin agent into the User tab for in-place editing (`u`).
- 2026-07-07: Responsive layout — column widths and wrapping now follow the live terminal size.
- 2026-07-07: Initial agents-wizard TUI — Project/User/Plugin tabs, create/edit/delete/view, bookmarks.
