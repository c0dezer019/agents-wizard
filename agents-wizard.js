#!/usr/bin/env node
'use strict';

/**
 * Agents Wizard — standalone terminal UI for managing Claude Code subagents.
 *
 * Real arrow-key / Enter navigation is only possible as a program that owns
 * the terminal directly. Claude Code's own slash commands/skills are just
 * text expanded into the conversation — they can't capture raw keystrokes
 * or draw into Claude Code's UI. So this is a plain Node script you run
 * yourself:
 *
 *   node agents-wizard.js
 *   (or: chmod +x agents-wizard.js && ./agents-wizard.js)
 *
 * No npm dependencies — uses only Node's built-in fs/path/os/readline/child_process.
 *
 * Creating an agent ("+ New agent") asks for role, seniority, and general
 * tasks instead of a raw description, then drafts a trigger description with
 * one `claude -p` call (tool use disabled via --tools "", so it's a pure
 * text-drafting call with nothing to hang on for permission). Once that
 * description exists, you pick how to finish the file:
 *   - Auto-draft with claude -p  — a second, also-tool-disabled `claude -p`
 *     call, using add_agent.md (in this same directory) as its system prompt
 *     via --system-prompt-file, drafting the complete file non-interactively.
 *   - Open interactive claude session — launches a real, interactive `claude`
 *     session (your terminal, full tool access, no --tools/-p restriction)
 *     with finish_agent_interactive.md as its system prompt and the same
 *     name/description/role/seniority/tasks as its opening message, so you
 *     can go back and forth before it writes the finished file itself.
 *   - Skip — writes the manual template directly.
 * Falls back to the manual template if the `claude` CLI is missing, the -p
 * call fails, or an interactive session ends without writing the file.
 * Either way, $EDITOR still opens afterward so you can review/adjust before
 * it's final.
 *
 * Controls:
 *   ← / →   switch tabs (Project / User / Plugin)
 *   ↑ / ↓   move selection (list scrolls to keep the selection visible)
 *   Enter   on an agent: launch it — runs `claude --agent <name>` as a real,
 *           foreground session until you exit it; on "+ New agent": create
 *           one; in Project/bookmarks mode: enter that project's agent list
 *   v       view the selected agent's raw file (any tab, including Plugin)
 *   e       edit the selected agent with $EDITOR (Project/User only)
 *   x       delete the selected agent, after retyping its name to confirm
 *           (Project/User only). On a tracked plugin agent shown in User,
 *           this untracks instead — the plugin's file is never touched.
 *   u       (Plugin tab only) track/untrack the selected agent into the
 *           User tab, for editing a plugin you own in place — see Scopes
 *           below
 *   b       (Project tab only) jump between cwd and bookmarks — see below
 *   Esc     (Project tab, inside an entered bookmark project) back to the
 *           bookmarks list
 *   d       (Project tab, bookmarks list only) remove the highlighted bookmark
 *   /       search across every scope at once — Project (cwd + every
 *           bookmarked project), User, and Plugin — matching the query
 *           against agent name, description, or its project/plugin label.
 *           Enter launches the highlighted result; Tab opens a menu for it
 *           (Launch/View/Edit/Delete, or Launch/View/Track for a
 *           not-yet-tracked plugin result — not bare v/e/x/u or Ctrl+letter,
 *           since this is a live text field and letters must stay free for
 *           typing the query, and Ctrl combos aren't reliable either, e.g.
 *           Ctrl+V is commonly claimed by the terminal/OS as Paste). Works
 *           from any tab.
 *   ?       show help on writing a good agent (name/description/tools/
 *           model/system-prompt guidance) — works from any tab
 *   q       quit (from the main list)
 *   Esc/q   back (from menus/viewer/help)
 *
 * Scopes:
 *   Project — three states, not two. Getting this wrong once already caused
 *             a bug (entering a bookmark used to overwrite the "current
 *             directory" itself, so there was no way back to where you
 *             actually launched the script from), so the rule is spelled
 *             out in full:
 *               cwd            — <cwd>/.claude/agents/, cwd being wherever
 *                                you launched this script from. Captured
 *                                once at startup and never overwritten by
 *                                anything that happens in bookmarks mode.
 *                                No walking up to parent directories either
 *                                (silently matched ~/.claude/agents when run
 *                                from deep inside $HOME with no closer
 *                                project folder — same dir as User, very
 *                                confusing).
 *               bookmarks      — a flat list of remembered project folders
 *                                (~/.claude/agents-wizard/config.json).
 *                                Enter on one moves to bookmark-project
 *                                (below). 'd' removes the highlighted
 *                                bookmark (just the shortcut, not the
 *                                folder) — no confirmation, it's non-
 *                                destructive.
 *               bookmark-project — showing one specific bookmarked project's
 *                                agents (same writable list as cwd mode,
 *                                just a different directory). Esc goes back
 *                                to the bookmarks list. 'b' goes to cwd.
 *             'b' semantics tie these together: from cwd, 'b' resumes
 *             whichever bookmark-related state you last left — the specific
 *             project if you left via 'b' from inside it, or the plain list
 *             if you left via 'b' from the list itself. Backing all the way
 *             out to the list (whether by Esc then 'b', or 'd'-ing the
 *             remembered bookmark) forgets the remembered project, so the
 *             next 'b' from cwd goes to the list, not back into it.
 *             Writable in cwd and bookmark-project.
 *   User    — ~/.claude/agents/ (personal, all projects). Writable. Also
 *             shows any "tracked" plugin agents (below) mixed into the same
 *             list — they're real rows here, not a separate section, so
 *             they get the exact same Enter/v/e/x treatment.
 *   Plugin  — every agents/ directory under ~/.claude/plugins/marketplaces/
 *             (see findPluginAgentDirs), deduped when the same agent is
 *             reachable via more than one registered marketplace (same
 *             name + identical content — see dedupeAgents). Never touches
 *             ~/.claude/plugins/cache/. Read-only in this tab (e/x do
 *             nothing here) — but 'u' tracks/untracks the highlighted agent
 *             into the User tab (marked with a ★ here once tracked), for
 *             when you own that plugin/marketplace checkout yourself and
 *             want to edit it directly. Tracking only remembers the file
 *             path in config (~/.claude/agents-wizard/config.json,
 *             trackedPluginAgents) — it does NOT copy the file into
 *             ~/.claude/agents/, so editing a tracked agent from the User
 *             tab edits the plugin's real file in place. That's the point
 *             (no fork/copy step for someone actively developing the
 *             plugin), but it does mean it's not a safe thing to do to a
 *             plugin you don't own — untracking ('x' on the linked row, or
 *             'u' again from here) only forgets the pointer and never
 *             touches the file either way.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');

// Creating an agent drafts its description and full file content by shelling
// out to `claude -p`, using this file as the system prompt for the main
// generation call (via --system-prompt-file, not stdin — piping a file into
// `claude -p "query" < file` makes the file part of the *user* turn, same as
// `cat file | claude -p`, not a system prompt). Resolved from __dirname so it
// works regardless of the cwd the wizard was launched from.
const ADD_AGENT_PROMPT_FILE = path.join(__dirname, 'add_agent.md');
// System prompt for the "open interactive claude session" finish path — a
// different file from ADD_AGENT_PROMPT_FILE because the instructions differ
// in kind, not just detail: that one tells claude to emit raw file content
// and nothing else (captured from stdout in a -p call); this one tells
// claude to have an actual back-and-forth with the user and write the file
// itself with its Write tool once they're both happy with it.
const ADD_AGENT_INTERACTIVE_PROMPT_FILE = path.join(__dirname, 'finish_agent_interactive.md');

const TABS = ['project', 'user', 'plugin'];

const BUILTIN_NAMES = new Set([
  'general-purpose',
  'Explore',
  'Plan',
  'statusline-setup',
  'claude-code-guide',
  'claude',
]);

// ---------------------------------------------------------------------------
// Scanning + parsing (pure, no terminal I/O — testable headlessly)
// ---------------------------------------------------------------------------

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function configFile() {
  return path.join(os.homedir(), '.claude', 'agents-wizard', 'config.json');
}

// trackedPluginAgents: absolute file paths of plugin-tab agents the user has
// chosen to surface (and make editable) in the User tab — see scanAll and
// the 'u' key in listLoop. Deliberately just a list of paths, not copies of
// the files themselves: the whole point is editing the plugin's own file in
// place (for someone developing or forking their own plugin locally), not
// forking content into ~/.claude/agents the way "+ New agent" does.
function loadConfig() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    const data = JSON.parse(raw);
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks.filter((b) => typeof b === 'string') : [];
    const trackedPluginAgents = Array.isArray(data.trackedPluginAgents)
      ? data.trackedPluginAgents.filter((p) => typeof p === 'string')
      : [];
    return { bookmarks, trackedPluginAgents };
  } catch {
    return { bookmarks: [], trackedPluginAgents: [] };
  }
}

function saveConfig(cfg) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ bookmarks: cfg.bookmarks, trackedPluginAgents: cfg.trackedPluginAgents }, null, 2) + '\n',
    'utf8'
  );
}

function listMdFiles(dir) {
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(dir, f))
    .sort();
}

// YAML allows quoting a scalar value (`name: "foo"` and `name: 'foo'` both
// mean the same as `name: foo`). Strip one matching pair of surrounding
// quotes if present, so callers get the actual identifier rather than the
// literal quote characters. Previously this parser only fed display text, so
// leftover quotes were cosmetic at worst -- now agent.name is also passed
// straight through to `claude --agent <name>`, where a quoted value like
// `"a11y-remediation-specialist"` is a genuinely different (nonexistent)
// agent name, not the one the user meant, and fails with "agent not found".
function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// Minimal top-level `key: value` frontmatter reader. Only pulls name/description
// for display purposes — Edit/Create never round-trip through this parser, they
// hand the raw file straight to $EDITOR, so there's no risk of this simplistic
// parser mangling tools/model/hooks/etc.
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: null, description: '', body: content };
  const [, fmBlock, body] = m;
  const fm = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s?(.*)$/);
    if (kv) fm[kv[1]] = stripQuotes(kv[2].trim());
  }
  return { name: fm.name || null, description: fm.description || '', body };
}

function loadAgentFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const fm = parseFrontmatter(raw);
  const base = path.basename(filePath, '.md');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // file vanished between listing and stat — leave mtimeMs at 0
  }
  return {
    name: fm.name || base,
    description: fm.description || '(no description)',
    file: filePath,
    raw,
    mtimeMs,
  };
}

// Plugin agents live at .claude/plugins/marketplaces/<marketplace>/<plugin>/agents/*.md
// — arbitrary marketplace/plugin nesting above the agents/ dir itself, so this
// walks looking for any directory named "agents" rather than assuming a fixed
// depth.
function findPluginAgentDirs(root, maxDepth = 6) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name === 'agents') {
        found.push(full);
      } else {
        walk(full, depth + 1);
      }
    }
  }
  walk(root, 0);
  return found;
}

// Display label for which plugin/marketplace a plugin-tab agent came from
// -- e.g. "some-marketplace/some-plugin" -- so agents that collide on name
// (real collisions, not the identical-content case dedupeAgents merges) are
// distinguishable in the list instead of looking like an unexplained dupe.
function pluginSourceLabel(filePath, root) {
  const rel = path.relative(root, filePath);
  const segments = rel.split(path.sep);
  const agentsIdx = segments.lastIndexOf('agents');
  const sourceSegments = agentsIdx > 0 ? segments.slice(0, agentsIdx) : segments.slice(0, -1);
  return sourceSegments.join('/') || '(unknown)';
}

// A plugin can be reachable from more than one registered marketplace (e.g.
// the same repo added under two marketplace names/aliases) -- that puts
// byte-identical agent files at two different paths under marketplaces/.
// Same name + identical file content is the signal that two hits are the
// same installed agent surfaced twice, not two distinct agents that happen
// to share a name (different content, same name, is left alone: that's a
// real cross-plugin naming collision, not a duplicate). Keep newest mtime.
function dedupeAgents(list) {
  const seen = new Map();
  for (const a of list) {
    const key = a.name + '\u0000' + a.raw;
    const existing = seen.get(key);
    if (!existing || a.mtimeMs > existing.mtimeMs) seen.set(key, a);
  }
  return Array.from(seen.values());
}

// cfg is optional (defaults to no tracked agents) so existing callers/tests
// that only care about project/user/plugin scanning don't need to know
// about tracking at all.
function scanAll(cwd, projectAgentsDir, cfg = { trackedPluginAgents: [] }) {
  const userDir = path.join(os.homedir(), '.claude', 'agents');
  const pluginMarketplacesRoot = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces');

  const project = listMdFiles(projectAgentsDir).map(loadAgentFile);
  const user = listMdFiles(userDir).map(loadAgentFile);
  const pluginRaw = findPluginAgentDirs(pluginMarketplacesRoot)
    .flatMap((dir) => listMdFiles(dir))
    .map((f) => ({ ...loadAgentFile(f), source: pluginSourceLabel(f, pluginMarketplacesRoot) }));
  // Dedupe keys on name+content only (source deliberately excluded) -- the
  // whole point is collapsing the same agent reachable from two
  // marketplaces into one row. Whichever copy has the newer mtime wins, so
  // its source is what gets displayed.
  const plugin = dedupeAgents(pluginRaw).sort((a, b) => a.name.localeCompare(b.name));

  // Tracked plugin agents ride along in the User tab's own list (not a
  // separate section) so they get the exact same Enter/v/e/x treatment any
  // other User-tab row gets -- `linked: true` is only there so the 'x'
  // handler in listLoop knows to untrack instead of deleting the file, and
  // so renderList can show where the row actually lives on disk. A tracked
  // path can go stale (plugin uninstalled, marketplace re-synced to a
  // different copy after dedup) -- silently drop it rather than throwing,
  // same tolerance listMdFiles already has for a missing directory.
  const linked = (cfg.trackedPluginAgents || [])
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .map((filePath) => ({
      ...loadAgentFile(filePath),
      source: pluginSourceLabel(filePath, pluginMarketplacesRoot),
      linked: true,
    }));

  return {
    project: { dir: projectAgentsDir, agents: project, writable: true },
    user: { dir: userDir, agents: [...user, ...linked], writable: true },
    plugin: { dir: pluginMarketplacesRoot, agents: plugin, writable: false },
  };
}

// Search (/) flattens every scope the wizard knows about into one list, each
// row tagged with a human "where" label — unlike the tab system, this needs
// to show agents from bookmarked projects the user *isn't* currently
// looking at, not just the active cwd/bookmark-project, so it re-scans every
// bookmark root directly rather than reusing scanAll (which only knows about
// whichever single project dir is "current"). writable mirrors what e/x
// would do if you navigated to that row's own scope normally.
function buildSearchIndex(cwd, cwdAgentsDir, cfg) {
  const entries = [];

  function addProjectDir(dir, label, root) {
    for (const agent of listMdFiles(dir).map(loadAgentFile)) {
      entries.push({ ...agent, scopeKind: 'project', label, root, writable: true });
    }
  }

  addProjectDir(cwdAgentsDir, `${path.basename(cwd)} (cwd)`, cwd);
  for (const root of cfg.bookmarks) {
    if (path.resolve(root) === path.resolve(cwd)) continue; // cwd already added above
    addProjectDir(path.join(root, '.claude', 'agents'), path.basename(root), root);
  }

  const userDir = path.join(os.homedir(), '.claude', 'agents');
  for (const agent of listMdFiles(userDir).map(loadAgentFile)) {
    entries.push({ ...agent, scopeKind: 'user', label: 'User', root: null, writable: true });
  }

  const pluginMarketplacesRoot = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces');
  const pluginRaw = findPluginAgentDirs(pluginMarketplacesRoot)
    .flatMap((dir) => listMdFiles(dir))
    .map((f) => ({ ...loadAgentFile(f), source: pluginSourceLabel(f, pluginMarketplacesRoot) }));
  for (const agent of dedupeAgents(pluginRaw)) {
    entries.push({ ...agent, scopeKind: 'plugin', label: agent.source, root: null, writable: false });
  }

  // Tracked (linked) plugin agents show up as User-tab rows here too, same
  // as scanAll does for the main list — writable: true because editing one
  // edits the real plugin file in place (see scanAll's comment), and
  // `linked: true` so searchFlow's Tab/Delete action untracks rather than
  // deleting that file.
  for (const filePath of cfg.trackedPluginAgents || []) {
    let isFile = false;
    try {
      isFile = fs.statSync(filePath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    const agent = loadAgentFile(filePath);
    entries.push({
      ...agent,
      scopeKind: 'user',
      // scopeTag in renderSearch already renders "[user]" for this row, so
      // the label only needs the "which plugin" part, not "User" again.
      label: `linked: ${pluginSourceLabel(filePath, pluginMarketplacesRoot)}`,
      root: null,
      writable: true,
      linked: true,
    });
  }

  return entries;
}

// "type either a plugin, project, or partial agent name" — one query, checked
// as a case-insensitive substring against all three: name, description, and
// the row's project/plugin label, rather than needing a mode switch to pick
// which field you're searching.
function filterSearchIndex(entries, query) {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.label.toLowerCase().includes(q)
  );
}

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

const ESC = '\x1B[';
const reverse = (s) => `${ESC}7m${s}${ESC}0m`;
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const clearScreen = () => `${ESC}2J${ESC}H`;

function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Column widths for the agent list re-derive from the live terminal width on
// every render (renderList is re-invoked on every keypress and on resize --
// see triggerRepaint/RESIZE_KEY), so name/source shrink or grow with the
// window instead of being fixed truncation lengths that clip on a narrow
// terminal or waste space on a wide one. Name/source cap out once they're
// wide enough to fit real content (MAX_NAME_WIDTH/MAX_SOURCE_WIDTH) so one
// unusually long entry can't starve the description column; whatever's left
// after those plus fixed gaps/markers goes to description, with a floor so
// it never goes negative on a tiny terminal.
const MIN_DESC_WIDTH = 10;
const MAX_NAME_WIDTH = 32;
const MAX_SOURCE_WIDTH = 30;

function computeColumnWidths(rows, tabKey, termWidth) {
  const realRows = rows.filter((r) => !r.virtual);
  const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(4, ...realRows.map((r) => r.name.length)));

  if (tabKey !== 'plugin') {
    const fixed = 2 /* indent */ + nameWidth + 2 /* gap */ + 2 /* '— ' */;
    return { nameWidth, descWidth: Math.max(MIN_DESC_WIDTH, termWidth - fixed) };
  }

  const sourceWidth = Math.min(MAX_SOURCE_WIDTH, Math.max(4, ...realRows.map((r) => (r.source || '').length)));
  const fixed =
    2 /* indent */ + 2 /* tracked marker */ + nameWidth + 1 /* gap */ + sourceWidth + 1 /* gap */ + 2 /* '— ' */;
  return { nameWidth, sourceWidth, descWidth: Math.max(MIN_DESC_WIDTH, termWidth - fixed) };
}

// Tracked so the process-exit handler below (which normally guarantees the
// terminal isn't left in alt-screen/hidden-cursor state no matter how the
// TUI exits) doesn't fire for non-TUI codepaths like `--update`, which never
// touch the screen at all and may be piped/redirected — writing raw escape
// codes into a non-terminal stdout would corrupt that output.
let inAltScreen = false;
function enterAltScreen() {
  process.stdout.write('\x1B[?1049h\x1B[?25l');
  inAltScreen = true;
}
function exitAltScreen() {
  process.stdout.write('\x1B[?25h\x1B[?1049l');
  inAltScreen = false;
}
function setRaw(enabled) {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(enabled);
  // readline.Interface#close() (used by askLine's text prompts) pauses the
  // underlying stream as part of its cleanup. setRawMode() only changes the
  // tty driver's raw/cooked mode — it doesn't re-flow a paused stream. Without
  // an explicit resume() here, stdin can end up paused with no active read
  // request, nothing left keeping the event loop alive, and the process
  // exits quietly instead of waiting for the next keypress.
  if (enabled) process.stdin.resume();
}

// Keypress events can arrive faster than the main loop consumes them (e.g. a
// terminal delivering several buffered escape sequences from one read, or
// arrow-key auto-repeat). A one-shot `.once('keypress', ...)` listener can
// miss events that fire while no listener is attached between awaits, so
// queue them instead: a single persistent listener feeds a FIFO queue, and
// waitForKey() drains it (or waits for the next arrival) — no drops, no
// reordering.
const keyQueue = [];
let keyResolver = null;

function onKeypressEvent(str, key) {
  // Keep `str` (the raw typed character(s)) alongside the symbolic `key`
  // fields — key.name is only set for keys readline recognizes by name
  // (return/escape/up/backspace/...); plain printable characters often have
  // no key.name at all. askLine's inline line editor needs the actual
  // character to append to its buffer, not just the symbolic name.
  const k = key ? { ...key, str } : { name: str, str };
  if (keyResolver) {
    const resolve = keyResolver;
    keyResolver = null;
    resolve(k);
  } else {
    keyQueue.push(k);
  }
}

function waitForKey() {
  if (keyQueue.length) return Promise.resolve(keyQueue.shift());
  return new Promise((resolve) => {
    keyResolver = resolve;
  });
}

// SIGWINCH (terminal resize) fires a 'resize' event on process.stdout, not a
// keypress — every render function already recomputes layout from
// process.stdout.rows/columns on each call, but the main loops only repaint
// once waitForKey() resolves, which normally means "a key was pressed".
// Without this, resizing the terminal leaves the last frame on screen
// (wrong viewport/scroll math) until the user happens to press a key. Wake
// whichever loop is currently waiting with a harmless synthetic key —
// '__resize__' matches no key.name check anywhere, so it just forces a
// re-render through the existing for(;;) loop with no side effects.
const RESIZE_KEY = { name: '__resize__', str: '' };
function triggerRepaint() {
  if (keyResolver) {
    const resolve = keyResolver;
    keyResolver = null;
    resolve(RESIZE_KEY);
  } else if (keyQueue[keyQueue.length - 1] !== RESIZE_KEY) {
    // Coalesce: don't let a burst of resize events queue up multiple
    // redundant repaints behind real keystrokes.
    keyQueue.push(RESIZE_KEY);
  }
}

// Keep-selection-visible viewport math: same idea viewFile already used for
// scrolling a single file, generalized to any row list. Adjusts the previous
// scroll offset by the minimum amount needed to bring `selIndex` back into
// view, rather than re-centering — so the list doesn't jump around as you
// move one row at a time.
function computeViewport(rowsLength, selIndex, prevScroll, viewHeight) {
  if (viewHeight <= 0) return 0;
  let scroll = prevScroll;
  if (selIndex < scroll) scroll = selIndex;
  if (selIndex >= scroll + viewHeight) scroll = selIndex - viewHeight + 1;
  const maxScroll = Math.max(0, rowsLength - viewHeight);
  return Math.min(Math.max(scroll, 0), maxScroll);
}

// Fixed chrome around the scrollable row list: title(1) + scope line(1) +
// blank(1) + tabs(1) + blank(1) + blank+footer(2) + reserve for an optional
// status message(2) = 9 lines. Keep in sync with renderList's literal output.
function listViewHeight() {
  const termRows = process.stdout.rows || 24;
  return Math.max(3, termRows - 9);
}

// projectMode is only meaningful for the 'project' tab: 'cwd' shows the
// active project directory's agents (the normal writable list, same shape as
// the User tab); 'bookmarks' replaces that with a picker over remembered
// project folders. cfg is only read in 'bookmarks' mode.
function rowsFor(data, tabKey, projectMode, cfg) {
  if (tabKey === 'plugin') return data.plugin.agents.slice();
  if (tabKey === 'project' && projectMode === 'bookmarks') {
    const rows = cfg.bookmarks.map((root) => ({ virtual: true, kind: 'bookmark', label: root, root }));
    rows.push({ virtual: true, kind: 'add-bookmark', label: '+ Add project folder…' });
    return rows;
  }
  const rows = [{ virtual: true, kind: 'new', label: '+ New agent' }];
  rows.push(...data[tabKey].agents);
  return rows;
}

function renderList(data, tabIndex, selIndex, scrollOffset, viewHeight, status, projectMode, cfg) {
  const tabKey = TABS[tabIndex];
  const rows = rowsFor(data, tabKey, projectMode, cfg);
  let out = clearScreen();
  out += bold('Agents Wizard') + '\n';
  const projectTag = projectMode === 'bookmark-project' ? '  (bookmark project)' : '';
  out += dim(`project: ${data.project.dir}${projectTag}   user: ${data.user.dir}`) + '\n\n';

  out +=
    TABS.map((t, i) => {
      const label = ` ${t[0].toUpperCase() + t.slice(1)} (${data[t].agents.length}) `;
      return i === tabIndex ? reverse(label) : dim(label);
    }).join('  ') + '\n\n';

  if (rows.length === 0) {
    out += dim('  (no agents found in this scope)') + '\n';
  } else {
    const termWidth = process.stdout.columns || 80;
    const cols = computeColumnWidths(rows, tabKey, termWidth);
    const visible = rows.slice(scrollOffset, scrollOffset + viewHeight);
    visible.forEach((row, i) => {
      const absoluteIndex = scrollOffset + i;
      // Plugin tab gets an extra source column (marketplace/plugin) since
      // the same agent name can legitimately come from two different
      // plugins -- dedupeAgents only collapses identical files, not name
      // collisions, so those need to stay visually distinguishable. Column
      // widths come from computeColumnWidths, which re-measures the
      // terminal on every render. A fixed 2-char marker column (blank when
      // not tracked) shows which plugin agents are currently tracked into
      // the User tab ('u' toggles it), without disturbing column alignment
      // for the untracked majority.
      const label = row.virtual
        ? row.label
        : tabKey === 'plugin'
          ? `${cfg.trackedPluginAgents.includes(row.file) ? '★ ' : '  '}${truncate(row.name, cols.nameWidth).padEnd(
              cols.nameWidth
            )} ${dim(truncate(row.source || '(unknown)', cols.sourceWidth).padEnd(cols.sourceWidth))} ${dim(
              '— ' + truncate(row.description, cols.descWidth)
            )}`
          : `${truncate(row.name, cols.nameWidth).padEnd(cols.nameWidth)}  ${dim(
              '— ' +
                truncate((row.linked ? `[linked: ${row.source}] ` : '') + row.description, cols.descWidth)
            )}`;
      const line = `  ${label}`;
      out += (absoluteIndex === selIndex ? reverse(line) : line) + '\n';
    });
  }

  const scrollHint =
    rows.length > viewHeight
      ? `   (${Math.min(scrollOffset + 1, rows.length)}-${Math.min(scrollOffset + viewHeight, rows.length)} of ${rows.length})`
      : '';
  let modeHint = '';
  if (tabKey === 'project') {
    if (projectMode === 'cwd') modeHint = '   b: bookmarks';
    else if (projectMode === 'bookmarks') modeHint = '   b: cwd   d: remove bookmark';
    else modeHint = '   Esc: bookmarks   b: cwd'; // bookmark-project
  }
  const editHint = data[tabKey].writable && !(tabKey === 'project' && projectMode === 'bookmarks') ? '   e edit   x delete' : '';
  const viewHint = tabKey === 'project' && projectMode === 'bookmarks' ? '' : '   v view';
  const trackHint = tabKey === 'plugin' ? '   u track/untrack → User tab' : '';
  out +=
    '\n' +
    dim(
      '←/→ tabs   ↑/↓ move   Enter run' +
        viewHint +
        editHint +
        trackHint +
        '   / search   ? help   q quit' +
        modeHint +
        scrollHint
    ) +
    '\n';
  if (status) out += '\n' + status + '\n';
  process.stdout.write(out);
}

// Flat result list, not tabbed — a match can come from any scope at once, so
// each row carries its own "[kind] label" tag (project name, "User", or
// plugin source) inline instead of relying on a tab to say where it's from.
function renderSearch(query, results, selIndex, scrollOffset, viewHeight, status) {
  let out = clearScreen();
  out += bold('Agents Wizard — search') + '\n\n';
  out += `Search: ${query}${reverse(' ')}` + '\n\n';

  if (results.length === 0) {
    out += dim(query ? '  (no matches)' : '  (type to search Project + User + Plugin agents by name/description/project)') + '\n';
  } else {
    const termWidth = process.stdout.columns || 80;
    const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(4, ...results.map((r) => r.name.length)));
    const tagWidth = Math.min(MAX_SOURCE_WIDTH, Math.max(4, ...results.map((r) => (r.label || '').length + 7)));
    const fixed = 2 /* indent */ + nameWidth + 1 /* gap */ + tagWidth + 1 /* gap */ + 2 /* '— ' */;
    const descWidth = Math.max(MIN_DESC_WIDTH, termWidth - fixed);
    const visible = results.slice(scrollOffset, scrollOffset + viewHeight);
    visible.forEach((row, i) => {
      const absoluteIndex = scrollOffset + i;
      const scopeTag = row.scopeKind === 'project' ? 'proj' : row.scopeKind === 'user' ? 'user' : 'plug';
      const tag = `[${scopeTag}] ${row.label}`;
      const label = `${truncate(row.name, nameWidth).padEnd(nameWidth)} ${dim(
        truncate(tag, tagWidth).padEnd(tagWidth)
      )} ${dim('— ' + truncate(row.description, descWidth))}`;
      const line = `  ${label}`;
      out += (absoluteIndex === selIndex ? reverse(line) : line) + '\n';
    });
  }

  const scrollHint =
    results.length > viewHeight
      ? `   (${Math.min(scrollOffset + 1, results.length)}-${Math.min(scrollOffset + viewHeight, results.length)} of ${results.length})`
      : '';
  out +=
    '\n' +
    dim('type to filter   ↑/↓ move   Enter run   Tab actions   Esc back' + scrollHint) +
    '\n';
  if (status) out += '\n' + status + '\n';
  process.stdout.write(out);
}

function renderMenu(title, subtitleLines, options, idx) {
  let out = clearScreen();
  out += bold(title) + '\n';
  for (const line of subtitleLines) out += dim(line) + '\n';
  out += '\n';
  options.forEach((opt, i) => {
    const line = `  ${opt}`;
    out += (i === idx ? reverse(line) : line) + '\n';
  });
  out += '\n' + dim('↑/↓ move   Enter select   Esc back') + '\n';
  process.stdout.write(out);
}

// renderViewer prints each entry in `lines` as exactly one on-screen row, so
// its own pager math (scroll/viewHeight) is only correct if that's actually
// true. Agent files routinely have long unwrapped lines (a system-prompt
// paragraph, a dense description) that run well past terminal width — left
// as-is, the terminal itself wraps them at write time into 2+ *visual* rows
// the pager never accounted for, so the total painted this frame exceeds
// process.stdout.rows and the terminal auto-scrolls mid-paint. That scrolls
// the title and the first several lines off the top of the screen before
// the frame even finishes — the "cut off at the top" symptom. Wrapping to
// `width` ourselves first makes one array entry == one visual row again, so
// viewHeight actually bounds what gets painted.
function wrapText(raw, width) {
  const w = Math.max(1, width);
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) {
      out.push('');
      continue;
    }
    for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w));
  }
  return out;
}

function renderViewer(agent, lines, scroll, viewHeight) {
  let out = clearScreen();
  out += bold(agent.file) + '\n\n';
  out += lines.slice(scroll, scroll + viewHeight).join('\n') + '\n';
  const last = Math.min(scroll + viewHeight, lines.length);
  out +=
    '\n' +
    dim(`↑/↓ scroll   PgUp/PgDn page (${lines.length ? scroll + 1 : 0}-${last}/${lines.length})   Esc/q back`) +
    '\n';
  process.stdout.write(out);
}

// ---------------------------------------------------------------------------
// Text-input prompts
// ---------------------------------------------------------------------------

// Pause/resume capture around anything that hands stdin to another reader —
// `readline.emitKeypressEvents` parses every byte on stdin into a 'keypress'
// event regardless of raw-mode state, so it doesn't know or care that an
// *external process* ($EDITOR, `claude`) is also about to read from the same
// stream once we hand it stdio: 'inherit'. Without pausing here, keystrokes
// typed into that external program would also land in our own nav keyQueue
// and get replayed as bogus navigation once we get the terminal back.
function pauseKeyCapture() {
  process.stdin.removeListener('keypress', onKeypressEvent);
}
function resumeKeyCapture() {
  keyQueue.length = 0;
  process.stdin.on('keypress', onKeypressEvent);
}

// Names keypress events can carry that represent editing/navigation keys
// rather than an actual character to insert into the text buffer.
const NON_TEXT_KEY_NAMES = new Set([
  'return',
  'enter',
  'escape',
  'backspace',
  'delete',
  'tab',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
]);

// Inline text-input prompt: reads one keystroke at a time off the same
// keyQueue/waitForKey() everything else in the wizard uses, and never leaves
// the alt screen or drops raw mode. Earlier this dropped to cooked mode via
// readline.createInterface, which meant every text prompt (name, role,
// description, delete confirmation, ...) visibly flipped the terminal out of
// the alt screen and back — the wizard's screen would flicker/disappear for
// a moment. Hand-rolling a plain append/backspace line editor (no cursor
// movement mid-string, no history) is a small enough job that it's worth
// doing here to keep everything on one screen instead.
async function askLine(promptText) {
  let buffer = '';
  for (;;) {
    let out = clearScreen();
    out += bold('Agents Wizard') + '\n\n';
    out += promptText + buffer + reverse(' ') + '\n\n';
    out += dim('Enter confirm   Esc cancel/clear') + '\n';
    process.stdout.write(out);
    setRaw(true);
    const key = await waitForKey();
    if (key.ctrl && key.name === 'c') process.exit(0);
    else if (key.name === 'return' || key.name === 'enter') return buffer.trim();
    else if (key.name === 'escape') return '';
    else if (key.name === 'backspace') buffer = buffer.slice(0, -1);
    else if (key.str && !key.ctrl && !key.meta && !NON_TEXT_KEY_NAMES.has(key.name) && !key.str.startsWith('\x1B')) {
      buffer += key.str;
    }
  }
}

function openEditor(filePath) {
  const editor =
    process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  const res = spawnSync(editor, [filePath], { stdio: 'inherit' });
  resumeKeyCapture();
  enterAltScreen();
  return { editor, res };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function viewFile(agent) {
  let scroll = 0;
  for (;;) {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    const viewHeight = Math.max(3, rows - 5);
    // Re-wrapped every frame (cheap at agent-file sizes) so a mid-view
    // terminal resize re-flows correctly instead of using stale widths.
    const lines = wrapText(agent.raw, cols);
    scroll = Math.min(scroll, Math.max(0, lines.length - viewHeight));
    renderViewer(agent, lines, scroll, viewHeight);
    setRaw(true);
    const key = await waitForKey();
    if (key.name === 'up') scroll = Math.max(0, scroll - 1);
    else if (key.name === 'down') scroll = Math.min(Math.max(0, lines.length - viewHeight), scroll + 1);
    else if (key.name === 'pageup') scroll = Math.max(0, scroll - viewHeight);
    else if (key.name === 'pagedown') scroll = Math.min(Math.max(0, lines.length - viewHeight), scroll + viewHeight);
    else if (key.name === 'escape' || key.name === 'q' || key.name === 'return') return;
    else if (key.ctrl && key.name === 'c') process.exit(0);
  }
}

// Same guidance add_agent.md/finish_agent_interactive.md hold claude to when
// drafting a file for you, restated for a human reader rather than as
// instructions addressed to claude — kept here as one plain constant instead
// of a separate file so the wizard has zero required files beyond itself.
const HELP_TEXT = `Writing a good agent
====================

An agent file has two jobs: get *picked*, and *behave well* once picked.
Most agents fail at the first job, not the second — Claude only ever reads
the description before deciding whether to delegate to an agent, so if that
one line doesn't read as a clear trigger, nothing else in the file matters.

Name
  Lowercase letters, digits, and hyphens, starting with a letter (e.g.
  code-reviewer). Must be unique in its scope and can't shadow a built-in
  (general-purpose, Explore, Plan, claude, statusline-setup,
  claude-code-guide).

Description — the delegation trigger
  Write it as a condition for use, not a summary of what the agent does.

    vague:   "Helps with code review"
    trigger: "Use PROACTIVELY after any multi-file change to check for
             security issues, missing error handling, and test coverage
             gaps before it's committed."

  The second version tells Claude exactly *when* to reach for this agent,
  not just what it's broadly about. "Use PROACTIVELY when..." is a good
  default frame if it fits the role.

Tools
  Omit the tools: field to inherit everything — that's the safe default.
  Only restrict it when the role clearly implies a narrow set: a read-only
  reviewer gets Read, Grep, Glob; a docs writer gets Read, Write, Edit,
  Grep, Glob. Guessing too narrow a list can silently block the agent
  partway through a task.

Model
  Omit to inherit the session's model. Only set it when there's a clear
  signal: haiku for lightweight or high-volume work, opus for complex,
  high-stakes, or judgment-heavy work.

Seniority — how it shapes agent behavior
  Seniority isn't a label, it's an instruction to yourself about how to write
  the system prompt: how prescriptive vs. open-ended it is, how much the
  agent is trusted to make a judgment call instead of following steps, and
  when it's expected to escalate back to you versus just deciding. The same
  task ("review this PR", "plan this migration") reads completely differently
  written for a junior agent than a principal one — the tools might be
  identical, but the instructions shouldn't be.

  junior
    Follows explicit, ordered steps and does not improvise. Flags anything
    the steps don't cover instead of guessing at intent. Best for narrow,
    repetitive, low-risk work where consistency matters more than judgment.
      "Follow these steps in order. If a step doesn't apply, skip it and say
      why. If you're unsure how to proceed, stop and ask rather than
      guessing."

  mid-level
    Handles the common variations of a task without hand-holding, but still
    escalates anything genuinely novel, ambiguous, or higher-risk than usual.
    Give it a checklist plus a few explicit judgment-call carve-outs, not a
    rigid script and not a blank check either.
      "Handle routine cases yourself using the checklist below. Use your own
      judgment for low-risk variations, but flag anything touching
      production data or security-sensitive code before proceeding."

  senior
    Owns a whole class of problem end to end: picks the approach, weighs
    tradeoffs, and only checks in when a decision has consequences beyond
    its immediate task. Write goals and constraints, not a step-by-step
    procedure — it should not need one.
      "You own <area>. Decide the right approach given the constraints
      below rather than waiting for step-by-step instructions. Push back if
      a request conflicts with those constraints instead of complying
      anyway."

  principal
    Operates with the most autonomy: expected to reason about second-order
    and systemic tradeoffs, not just the immediate task, and to actively
    say so if the request itself is the wrong call — not merely execute it
    well.
      "You're the final judgment call on <area>. Weigh tradeoffs beyond the
      immediate task, and tell me directly if what's being asked is a
      mistake, even if that means disagreeing with the request."

  More examples, same role at different levels:
    code-reviewer
      junior:    checks a fixed list of lint/style rules; anything outside
                 that list gets flagged for a human, not decided on.
      senior:    reviews for correctness, security, and architectural fit;
                 decides which issues actually block the merge.
    database-migration-specialist
      mid-level: runs a known migration checklist; escalates anything
                 involving downtime or data-loss risk instead of proceeding.
      principal: designs the migration strategy itself, rollback plan
                 included, and is expected to refuse an unsafe approach.
    incident-responder
      junior:    follows the runbook step by step; pages a human the moment
                 the runbook doesn't cover the situation.
      principal: makes real-time triage and mitigation calls with no
                 runbook, and owns the postmortem's root-cause judgment.

System prompt body
  Write it in second person ("You are...", "You will...") and make it
  genuinely specific to the role — generic boilerplate is about as useful
  as no system prompt at all. This is where the seniority guidance above
  actually gets applied: bake the prescriptiveness/autonomy level straight
  into the wording, don't just mention the seniority as a label and leave
  the rest generic.

Common role examples
  Starting points for the roles that come up most — pick one and adjust the
  tasks/seniority to fit rather than starting from a blank page.

  code-reviewer
    description: "Use PROACTIVELY after any non-trivial code change to
                 review for correctness, security issues, and style
                 violations before it's merged."
    tools:       Read, Grep, Glob (read-only — it reviews, it doesn't fix)
    model:       omit, unless review volume is high (haiku) or the codebase
                 is unusually complex/high-stakes (opus)

  test-writer
    description: "Use when new functionality needs test coverage, or
                 existing tests need updating after a behavior change."
    tools:       Read, Write, Edit, Grep, Glob
    model:       omit

  docs-writer
    description: "Use after a feature or API change to update README,
                 docs, or inline comments to match the new behavior."
    tools:       Read, Write, Edit, Grep, Glob
    model:       omit

  research-agent (investigate, don't modify)
    description: "Use for open-ended investigation — where something is
                 defined, how a system behaves, or gathering background
                 before a decision — not for making changes."
    tools:       Read, Grep, Glob, WebSearch, WebFetch (no Write/Edit)
    model:       omit

  migration-specialist / large refactor
    description: "Use PROACTIVELY when a large-scale rename, dependency
                 upgrade, or structural refactor spans many files."
    tools:       omit (broad access genuinely needed across the codebase)
    model:       opus if the migration is high-risk or judgment-heavy

  incident-responder
    description: "Use when production behavior is unexpected or an alert
                 fires, to triage, gather diagnostics, and propose
                 mitigation."
    tools:       Read, Bash, Grep, Glob
    model:       omit, unless the org wants faster/cheaper first-response
                 triage (haiku) with escalation to a human for the fix

Fastest path
  Use "+ New agent" and answer the role/seniority/tasks questions — claude
  drafts the description for you, then (your choice) either drafts the
  whole file too, walks through it with you interactively, or leaves you a
  manual template. $EDITOR opens afterward either way, so nothing here is
  final until you close it.
`;

async function showHelp() {
  const lines = HELP_TEXT.split('\n');
  let scroll = 0;
  for (;;) {
    const rows = process.stdout.rows || 24;
    const viewHeight = Math.max(3, rows - 5);
    let out = clearScreen();
    out += bold('Writing a good agent — help') + '\n\n';
    out += lines.slice(scroll, scroll + viewHeight).join('\n') + '\n';
    const last = Math.min(scroll + viewHeight, lines.length);
    out +=
      '\n' + dim(`↑/↓ scroll (${lines.length ? scroll + 1 : 0}-${last}/${lines.length})   Esc/q back`) + '\n';
    process.stdout.write(out);
    setRaw(true);
    const key = await waitForKey();
    if (key.name === 'up') scroll = Math.max(0, scroll - 1);
    else if (key.name === 'down') scroll = Math.min(Math.max(0, lines.length - viewHeight), scroll + 1);
    else if (key.name === 'escape' || key.name === 'q' || key.name === 'return') return;
    else if (key.ctrl && key.name === 'c') process.exit(0);
  }
}

// Enter on a real agent row launches it directly, same terminal-handoff
// pattern as openEditor/runClaudeInteractive: exit the alt screen, hand
// stdio over entirely, and restore our own state once `claude --agent ...`
// exits (however the user exits it). Not async — spawnSync blocks — but
// callers await it like the other action handlers without issue.
function runAgentSession(agent) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  process.stdout.write(
    `\nStarting claude --agent ${agent.name} (exit the session normally to return to the wizard)...\n\n`
  );
  const res = spawnSync('claude', ['--agent', agent.name], { stdio: 'inherit' });
  resumeKeyCapture();
  enterAltScreen();
  if (res.error) return `Could not launch "claude --agent ${agent.name}": ${res.error.message}`;
  return '';
}

async function editAgent(agent) {
  const { editor, res } = openEditor(agent.file);
  if (res.error) return `Could not launch editor "${editor}": ${res.error.message}`;
  return `Edited ${path.basename(agent.file)} with ${editor}.`;
}

async function deleteAgent(agent) {
  const typed = await askLine(`Type "${agent.name}" to confirm delete (anything else cancels): `);
  if (typed !== agent.name) return 'Delete cancelled.';
  fs.unlinkSync(agent.file);
  return `Deleted ${path.basename(agent.file)}.`;
}

// The 'x'/Delete action on a `linked: true` row (a tracked plugin agent
// surfaced in the User tab — see scanAll) removes the tracking pointer from
// config only. The plugin's actual file is left completely alone: deleting
// someone's plugin source out from under them because they hit the same key
// they'd use to delete a real user agent would be a nasty surprise. Same
// non-destructive spirit as removing a bookmark ('d' in Project/bookmarks
// mode) — no retype-to-confirm, because nothing is actually being destroyed.
function untrackPluginAgent(cfg, agent) {
  cfg.trackedPluginAgents = cfg.trackedPluginAgents.filter((fp) => fp !== agent.file);
  saveConfig(cfg);
  return `Untracked ${agent.name} from User tab (plugin file itself untouched).`;
}

function trackPluginAgent(cfg, agent) {
  if (!cfg.trackedPluginAgents.includes(agent.file)) cfg.trackedPluginAgents.push(agent.file);
  saveConfig(cfg);
  return `Tracked ${agent.name} into User tab — editing it there edits this plugin file directly (only do this for a plugin you own/are developing).`;
}

// Shared by the main list's 'u' hotkey and search's Tab menu — flips a
// Plugin-scope row between tracked/untracked, applying the right side
// effect (and status message) for whichever state it's leaving.
function toggleTrackedPluginAgent(cfg, agent) {
  return cfg.trackedPluginAgents.includes(agent.file) ? untrackPluginAgent(cfg, agent) : trackPluginAgent(cfg, agent);
}

// Live-filtered search over every scope at once (Project cwd + every
// bookmarked project + User + Plugin) — reuses the same keyQueue/waitForKey
// character-at-a-time approach as askLine, but renders a filtered result
// list under the query instead of a single-line prompt. Enter launches the
// highlighted result directly (the common case). View/Edit/Delete are
// tucked behind Tab -> a pickOption menu instead of bare hotkeys or Ctrl
// combos: this is a live text field, so bare letters must stay free for
// typing the query (a bare 'e' both inserted into the query *and* fired the
// edit hotkey), and Ctrl+letter isn't reliable either — Ctrl+V in particular
// is commonly eaten by the terminal/OS as its own Paste shortcut before the
// byte ever reaches this process. Tab and pickOption's arrow-key navigation
// don't collide with anything typeable, so this sidesteps both problems.
// Re-scans the filesystem on every keystroke, same as the main loop already
// does per-render via scanAll — fine at agent-file counts, no caching needed.
async function searchFlow(cwd, cwdAgentsDir, cfg) {
  let query = '';
  let selIndex = 0;
  let scrollOffset = 0;
  let status = '';
  for (;;) {
    const results = filterSearchIndex(buildSearchIndex(cwd, cwdAgentsDir, cfg), query);
    if (selIndex >= results.length) selIndex = Math.max(0, results.length - 1);
    const termRows = process.stdout.rows || 24;
    const viewHeight = Math.max(3, termRows - (status ? 10 : 8));
    scrollOffset = computeViewport(results.length, selIndex, scrollOffset, viewHeight);
    renderSearch(query, results, selIndex, scrollOffset, viewHeight, status);
    status = '';

    setRaw(true);
    const key = await waitForKey();
    const row = results[selIndex];
    if (key.ctrl && key.name === 'c') process.exit(0);
    else if (key.name === 'escape') return;
    else if (key.name === 'up') selIndex = Math.max(0, selIndex - 1);
    else if (key.name === 'down') selIndex = Math.min(results.length - 1, selIndex + 1);
    else if (key.name === 'return' || key.name === 'enter') {
      if (row) status = runAgentSession(row);
    } else if (key.name === 'tab') {
      if (row) {
        // Linked (tracked plugin) rows get "Untrack" instead of "Delete" —
        // same file-safety reasoning as untrackPluginAgent itself. Plain
        // Plugin-scope rows (not yet tracked, not writable at all) get a
        // Track/Untrack option instead of Edit/Delete, same toggle as the
        // main list's 'u' hotkey — this is the only way to reach that
        // action from inside search, since 'u' would just be a query
        // character here.
        const deleteLabel = row.linked ? 'Untrack from User tab' : 'Delete';
        const trackLabel = cfg.trackedPluginAgents.includes(row.file) ? 'Untrack from User tab' : 'Track into User tab';
        const options = row.writable
          ? ['Launch', 'View', 'Edit', deleteLabel]
          : row.scopeKind === 'plugin'
            ? ['Launch', 'View', trackLabel]
            : ['Launch', 'View'];
        const choice = await pickOption(row.name, [`[${row.scopeKind}] ${row.label}`, row.description], options);
        if (choice === 'Launch') status = runAgentSession(row);
        else if (choice === 'View') await viewFile(row);
        else if (choice === 'Edit') status = await editAgent(row);
        else if (row.writable && choice === deleteLabel) {
          status = row.linked ? untrackPluginAgent(cfg, row) : await deleteAgent(row);
        } else if (row.scopeKind === 'plugin' && choice === trackLabel) {
          status = toggleTrackedPluginAgent(cfg, row);
        }
      }
    } else if (key.name === 'backspace') {
      query = query.slice(0, -1);
      selIndex = 0;
    } else if (key.str && !key.ctrl && !key.meta && !NON_TEXT_KEY_NAMES.has(key.name) && !key.str.startsWith('\x1B')) {
      query += key.str;
      selIndex = 0;
    }
  }
}

// Generic arrow-key option picker — View/Edit/Delete used to be one of these
// (a "what do you want to do with this agent" menu on Enter); that's gone
// now, replaced by direct v/e/x hotkeys, but the create-flow "how should
// claude finish this file?" choice still uses this picker.
async function pickOption(title, subtitleLines, options) {
  let idx = 0;
  for (;;) {
    renderMenu(title, subtitleLines, options, idx);
    setRaw(true);
    const key = await waitForKey();
    if (key.ctrl && key.name === 'c') process.exit(0);
    else if (key.name === 'up') idx = (idx + options.length - 1) % options.length;
    else if (key.name === 'down') idx = (idx + 1) % options.length;
    else if (key.name === 'escape' || key.name === 'q') return null;
    else if (key.name === 'return') return options[idx];
  }
}

// Bookmarks-mode "+ Add project folder" flow: prompts for a path, offers to
// create it if missing, saves it to cfg, and returns the project ROOT (not
// the agents subdir — callers derive that, same as bookmark rows already do)
// so it can be entered as a bookmark-project. Returns null if backed out.
async function addProjectFolder(cwd, cfg) {
  const typed = await askLine('Path to project folder (absolute or ~/…, blank = current directory): ');
  const root = path.resolve(expandHome(typed) || cwd);
  if (!isDir(root)) {
    const confirm = await askLine(`"${root}" doesn't exist. Create it and add anyway? (y/N): `);
    if (confirm.trim().toLowerCase() !== 'y') return null;
    fs.mkdirSync(root, { recursive: true });
  }
  if (!cfg.bookmarks.includes(root)) {
    cfg.bookmarks.push(root);
    saveConfig(cfg);
  }
  return root;
}

function buildManualTemplate(name, description) {
  return `---
name: ${name}
description: ${description || 'TODO: describe when Claude should delegate to this agent'}
# tools: Read, Grep, Glob   # omit this line to inherit all tools
# model: sonnet             # omit this line to inherit the session model
---

TODO: write the system prompt / instructions for this agent here.
`;
}

// Runs `claude -p` with tool use disabled (--tools "") — this is a pure
// text-in/text-out drafting call, not an agentic task, and forcing no tools
// means no permission prompts to hang on in this non-interactive context.
// Args are passed as an array straight to spawnSync (no shell involved), so
// arbitrary user-typed text (role/seniority/tasks) can't break out via quotes
// or shell metacharacters — there's no shell to break out of.
function runClaudeGenerate(promptText, { systemPrompt, systemPromptFile, label } = {}) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  process.stdout.write(`\n${label || 'Calling claude...'}\n`);
  const args = ['-p', promptText, '--tools', ''];
  if (systemPromptFile) args.push('--system-prompt-file', systemPromptFile);
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  const res = spawnSync('claude', args, { encoding: 'utf8', timeout: 120000 });
  resumeKeyCapture();
  enterAltScreen();
  return res;
}

function describeClaudeError(res) {
  if (res.error && res.error.code === 'ENOENT') return 'claude CLI not found in PATH';
  if (res.error) return res.error.message;
  if (res.signal === 'SIGTERM') return 'claude timed out';
  const stderr = (res.stderr || '').trim();
  return stderr ? stderr.split('\n').slice(0, 3).join(' ') : `claude exited with status ${res.status}`;
}

// First of the two claude calls: turns the guided Q&A answers into a single
// trigger-description sentence. Small, focused system prompt passed inline
// rather than via add_agent.md — that file is only for the full-file call.
async function generateDescription(role, seniority, tasks) {
  const prompt = `Role: ${role}\nSeniority: ${seniority}\nGeneral tasks: ${tasks}`;
  const res = runClaudeGenerate(prompt, {
    systemPrompt:
      'You write a single-sentence "description" field for a Claude Code subagent\'s frontmatter. ' +
      'This sentence is the trigger Claude reads to decide when to delegate to the subagent, so phrase it ' +
      'as a concrete condition for use. Output ONLY that one sentence — no quotes, no markdown, no preamble.',
    label: 'Asking claude to draft a description from your answers...',
  });
  if (res.error || res.status !== 0) return { ok: false, error: describeClaudeError(res) };
  const description = (res.stdout || '').trim();
  if (!description) return { ok: false, error: 'claude returned an empty description' };
  return { ok: true, description };
}

// Second call: the full agent file (frontmatter + system prompt body), using
// add_agent.md as the system prompt via --system-prompt-file.
async function generateAgentFile(scopeDir, name, description, role, seniority, tasks) {
  const prompt = [
    `Directory: ${scopeDir}`,
    `Agent name: ${name}`,
    `Description: ${description}`,
    '',
    `Role: ${role}`,
    `Seniority: ${seniority}`,
    `General tasks: ${tasks}`,
  ].join('\n');
  const res = runClaudeGenerate(prompt, {
    systemPromptFile: ADD_AGENT_PROMPT_FILE,
    label: 'Asking claude to draft the agent file...',
  });
  if (res.error || res.status !== 0) return { ok: false, error: describeClaudeError(res) };
  const content = (res.stdout || '').trim() + '\n';
  if (!content.startsWith('---')) {
    return { ok: false, error: "claude's output didn't look like a valid agent file (missing frontmatter)" };
  }
  return { ok: true, content };
}

// Launches a real interactive `claude` session (no -p, no --tools
// restriction) attached straight to the terminal, same idea as openEditor —
// stdio: 'inherit' hands the terminal over entirely until the session ends
// (user exits it normally, e.g. Ctrl+D or /exit). Unlike the -p calls above,
// this isn't captured/parsed: claude is expected to write the finished file
// itself, at the exact path given in promptText, using its own Write tool.
function runClaudeInteractive(promptText, systemPromptFile) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  process.stdout.write(
    '\nStarting an interactive claude session to finish this agent together ' +
      '(exit the session normally, e.g. Ctrl+D, to return to the wizard)...\n\n'
  );
  const res = spawnSync('claude', ['--system-prompt-file', systemPromptFile, promptText], {
    stdio: 'inherit',
  });
  resumeKeyCapture();
  enterAltScreen();
  return res;
}

function buildInteractivePrompt(target, name, description, role, seniority, tasks) {
  return [
    `Target file path: ${target}`,
    `Agent name: ${name}`,
    `Description: ${description}`,
    '',
    `Role: ${role}`,
    `Seniority: ${seniority}`,
    `General tasks: ${tasks}`,
  ].join('\n');
}

// Total fallback if claude can't even draft a description (e.g. the CLI
// isn't installed at all): ask for a plain description by hand and use the
// old manual template, same as before this feature existed.
async function manualCreateFallback(scopeDir, target, name, warning) {
  const description = await askLine('One-line description (this is the delegation trigger Claude reads): ');
  const dirExisted = isDir(scopeDir);
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(target, buildManualTemplate(name, description), 'utf8');
  const { editor, res } = openEditor(target);
  let note = `${warning} Created ${target}.`;
  if (res.error) note += ` (Could not launch editor "${editor}": ${res.error.message})`;
  if (!dirExisted) note += ' New agents/ directory — restart Claude Code to pick it up.';
  return note;
}

async function createFlow(data, tabKey) {
  const scopeDir = tabKey === 'project' ? data.project.dir : path.join(os.homedir(), '.claude', 'agents');

  const name = await askLine('New agent name (lowercase-hyphens, e.g. code-reviewer): ');
  if (!name) return 'Create cancelled (empty name).';
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'Create cancelled: name must be lowercase letters/digits/hyphens, starting with a letter.';
  }
  if (BUILTIN_NAMES.has(name)) {
    return `Create cancelled: "${name}" is a built-in agent name and can't be shadowed.`;
  }
  const target = path.join(scopeDir, `${name}.md`);
  if (fs.existsSync(target)) {
    return `Create cancelled: ${target} already exists — use Edit instead.`;
  }

  const role = await askLine(
    'Role — what should this agent be? (e.g. "code reviewer", "database migration specialist"): '
  );
  const seniority = await askLine('Seniority / experience level? (e.g. junior, senior, principal): ');
  const tasks = await askLine('General tasks it will perform (a sentence, or comma-separated list): ');

  const descResult = await generateDescription(role, seniority, tasks);
  if (!descResult.ok) {
    return manualCreateFallback(
      scopeDir,
      target,
      name,
      `Couldn't draft a description via claude (${descResult.error}).`
    );
  }
  const { description } = descResult;

  const finishChoice = await pickOption(
    'How should claude finish drafting this file?',
    [`name: ${name}`, `description: "${description}"`],
    ['Auto-draft with claude -p', 'Open interactive claude session', 'Skip — use manual template']
  );

  const dirExisted = isDir(scopeDir);
  fs.mkdirSync(scopeDir, { recursive: true });

  let note;
  if (finishChoice === 'Open interactive claude session') {
    const prompt = buildInteractivePrompt(target, name, description, role, seniority, tasks);
    runClaudeInteractive(prompt, ADD_AGENT_INTERACTIVE_PROMPT_FILE);
    // claude was told to write the file itself with its Write tool. If the
    // session ended (however it ended) without that happening, fall back
    // rather than leaving nothing on disk.
    if (fs.existsSync(target)) {
      note = `Created ${target} (finished interactively with claude).`;
    } else {
      fs.writeFileSync(target, buildManualTemplate(name, description), 'utf8');
      note = `Created ${target} with a manual template — the interactive session ended without writing the file.`;
    }
  } else if (finishChoice === 'Auto-draft with claude -p') {
    const fileResult = await generateAgentFile(scopeDir, name, description, role, seniority, tasks);
    if (fileResult.ok) {
      fs.writeFileSync(target, fileResult.content, 'utf8');
      note = `Created ${target} (drafted by claude — description: "${description}").`;
    } else {
      // The description call worked even though the full-file call didn't —
      // keep that result rather than throwing it away.
      fs.writeFileSync(target, buildManualTemplate(name, description), 'utf8');
      note = `Created ${target} with a manual template — claude couldn't draft the full file (${fileResult.error}).`;
    }
  } else {
    // null (Esc/q) or explicit "Skip" — manual template, keeping the
    // already-generated description rather than losing it.
    fs.writeFileSync(target, buildManualTemplate(name, description), 'utf8');
    note = `Created ${target} with a manual template.`;
  }

  const { editor, res } = openEditor(target);
  if (res.error) note += ` (Could not launch editor "${editor}": ${res.error.message})`;
  if (!dirExisted) {
    note += ' New agents/ directory — restart Claude Code to pick it up.';
  }
  return note;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Project has three states (cwd / bookmarks-list / bookmark-project), each
// rendered through the same generic list machinery but needing independent
// cursor/scroll state — otherwise moving between them would reset your place
// in whatever you just left. Route selIndex/scrollOffset through separate
// keys per state.
function stateKey(tabKey, projectMode) {
  if (tabKey !== 'project') return tabKey;
  if (projectMode === 'bookmarks') return 'projectBookmarks';
  if (projectMode === 'bookmark-project') return 'projectBookmarkProject';
  return 'project';
}

async function listLoop() {
  const cwd = process.cwd();
  const cfg = loadConfig();
  // Fixed for the whole session — nothing in bookmarks mode is allowed to
  // overwrite this. (Previous version pointed a single mutable
  // "activeProjectDir" at whatever was last entered, which meant entering a
  // bookmark destroyed any way back to the actual cwd. That's the bug this
  // three-state design exists to fix.)
  const cwdAgentsDir = path.join(cwd, '.claude', 'agents');
  let selectedBookmarkRoot = null; // project ROOT (not agents dir) of the entered bookmark, if any
  let projectMode = 'cwd'; // 'cwd' | 'bookmarks' | 'bookmark-project'
  let tabIndex = 0;
  const selIndex = { project: 0, user: 0, plugin: 0, projectBookmarks: 0, projectBookmarkProject: 0 };
  const scrollOffset = { project: 0, user: 0, plugin: 0, projectBookmarks: 0, projectBookmarkProject: 0 };
  let status = '';

  function currentProjectAgentsDir() {
    if (projectMode === 'bookmark-project' && selectedBookmarkRoot) {
      return path.join(selectedBookmarkRoot, '.claude', 'agents');
    }
    return cwdAgentsDir;
  }

  // Enter a bookmark's project view. Only resets that state's own cursor
  // when pointed at a genuinely different project than last time — toggling
  // back into the *same* one later (via 'b') should keep your place there too.
  function enterBookmarkProject(root) {
    if (root !== selectedBookmarkRoot) {
      selIndex.projectBookmarkProject = 0;
      scrollOffset.projectBookmarkProject = 0;
    }
    selectedBookmarkRoot = root;
    projectMode = 'bookmark-project';
  }

  for (;;) {
    const tabKey = TABS[tabIndex];
    const sKey = stateKey(tabKey, projectMode);
    const data = scanAll(cwd, currentProjectAgentsDir(), cfg);
    let rows = rowsFor(data, tabKey, projectMode, cfg);
    if (selIndex[sKey] >= rows.length) selIndex[sKey] = Math.max(0, rows.length - 1);
    const viewHeight = listViewHeight();
    scrollOffset[sKey] = computeViewport(rows.length, selIndex[sKey], scrollOffset[sKey], viewHeight);

    renderList(data, tabIndex, selIndex[sKey], scrollOffset[sKey], viewHeight, status, projectMode, cfg);
    status = '';

    setRaw(true);
    const key = await waitForKey();

    if ((key.ctrl && key.name === 'c') || key.name === 'q') return;
    else if (key.name === 'left') tabIndex = (tabIndex + TABS.length - 1) % TABS.length;
    else if (key.name === 'right') tabIndex = (tabIndex + 1) % TABS.length;
    else if (key.name === 'up') selIndex[sKey] = Math.max(0, selIndex[sKey] - 1);
    else if (key.name === 'down') selIndex[sKey] = Math.min(rows.length - 1, selIndex[sKey] + 1);
    else if (key.name === 'escape' && tabKey === 'project' && projectMode === 'bookmark-project') {
      projectMode = 'bookmarks'; // selectedBookmarkRoot stays remembered
    } else if (key.name === 'b' && tabKey === 'project') {
      if (projectMode === 'cwd') {
        // Resume wherever bookmarks-land was last left: the specific
        // project if one is still remembered, otherwise the plain list.
        projectMode = selectedBookmarkRoot ? 'bookmark-project' : 'bookmarks';
      } else if (projectMode === 'bookmarks') {
        // Backing out from the plain list, not from a specific project:
        // forget the remembered project, so the next 'b' from cwd goes to
        // the list again instead of jumping back into it.
        selectedBookmarkRoot = null;
        projectMode = 'cwd';
      } else {
        // bookmark-project -> cwd. Keep selectedBookmarkRoot so the next
        // 'b' resumes this same project.
        projectMode = 'cwd';
      }
    } else if (key.name === 'd' && tabKey === 'project' && projectMode === 'bookmarks') {
      const row = rows[selIndex[sKey]];
      if (row && row.kind === 'bookmark') {
        cfg.bookmarks = cfg.bookmarks.filter((b) => b !== row.root);
        saveConfig(cfg);
        status = `Removed bookmark: ${row.root}`;
        if (row.root === selectedBookmarkRoot) selectedBookmarkRoot = null;
      }
    } else if (key.name === 'return') {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row) {
        if (tabKey === 'project' && projectMode === 'bookmarks') {
          if (row.kind === 'add-bookmark') {
            const picked = await addProjectFolder(cwd, cfg);
            if (picked) enterBookmarkProject(picked);
          } else if (row.kind === 'bookmark') {
            enterBookmarkProject(row.root);
          }
        } else if (row.kind === 'new') {
          status = await createFlow(data, tabKey);
        } else if (!row.virtual) {
          // Enter runs the agent directly rather than opening a menu —
          // picking an agent to actually use is the far more common action
          // than managing its file. View/Edit/Delete are direct hotkeys now
          // (v/e/x below), not a submenu.
          status = runAgentSession(row);
        }
      }
    } else if (key.name === 'v') {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) await viewFile(row);
    } else if (key.name === 'e' && data[tabKey].writable) {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) status = await editAgent(row);
    } else if (key.name === 'x' && data[tabKey].writable) {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) {
        status = row.linked ? untrackPluginAgent(cfg, row) : await deleteAgent(row);
      }
    } else if (key.str === 'u' && tabKey === 'plugin') {
      // Track/untrack toggle — Plugin tab's own scope stays read-only
      // (data.plugin.writable is still false, so 'e'/'x' here still do
      // nothing), but this doesn't write to the plugin file at all, just to
      // our own config, so it doesn't need that guard.
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) status = toggleTrackedPluginAgent(cfg, row);
    } else if (key.str === '/') {
      // Global, like '?' — doesn't depend on tab/projectMode, so no row
      // lookup needed here. cfg is passed by reference; searchFlow's own
      // edit/delete calls don't touch bookmarks, so nothing needs re-syncing
      // on return.
      await searchFlow(cwd, cwdAgentsDir, cfg);
    } else if (key.str === '?') {
      // Global — doesn't depend on tab/row, so no row lookup needed.
      await showHelp();
    }
  }
}

// `lsagents --update` — pulls this checkout to the latest repo HEAD. Since
// the installed binary is a symlink (or, on Windows without Developer
// Mode/admin, a shim pointing straight at this file — see install.ps1), a
// plain `git pull` in place is all that's needed for the change to take
// effect; no re-linking required. Doesn't touch the TUI/TTY machinery at
// all, so it works fine piped, in scripts, cron, etc.
function runUpdate() {
  const repoDir = __dirname;
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.error(`error: ${repoDir} is not a git checkout (no .git found) — can't update.`);
    process.exit(1);
  }
  console.log(`Updating agents-wizard in ${repoDir}...`);
  const res = spawnSync('git', ['-C', repoDir, 'pull'], { stdio: 'inherit' });
  if (res.error) {
    console.error(`error: failed to run git: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('agents-wizard needs an interactive terminal (TTY). Run it directly, not piped.');
    process.exit(1);
  }
  readline.emitKeypressEvents(process.stdin);
  resumeKeyCapture();
  enterAltScreen();
  // Only listen while we own the terminal. During openEditor/runAgentSession/
  // runClaudeGenerate/runClaudeInteractive, stdio is 'inherit'-ed to a child
  // process (spawnSync, which blocks the event loop entirely) — no repaint
  // should happen mid-handoff anyway, and removing the listener means a
  // resize during that window doesn't leave a stray queued key waiting for
  // us when we get stdin back.
  process.stdout.on('resize', triggerRepaint);
  try {
    await listLoop();
  } finally {
    process.stdout.removeListener('resize', triggerRepaint);
    exitAltScreen();
    setRaw(false);
  }
  // stdin's keypress listener + raw mode keep the event loop alive even
  // after we're done; exit explicitly rather than leaving the process hung.
  process.exit(0);
}

process.on('exit', () => {
  try {
    setRaw(false);
  } catch {}
  if (inAltScreen) process.stdout.write('\x1B[?25h\x1B[?1049l');
});

module.exports = {
  parseFrontmatter,
  loadAgentFile,
  findPluginAgentDirs,
  dedupeAgents,
  computeViewport,
  computeColumnWidths,
  truncate,
  scanAll,
  buildSearchIndex,
  filterSearchIndex,
  expandHome,
  configFile,
  loadConfig,
  saveConfig,
  BUILTIN_NAMES,
  buildManualTemplate,
  describeClaudeError,
  buildInteractivePrompt,
};

if (require.main === module) {
  if (process.argv.includes('--update')) {
    runUpdate();
  } else {
    main().catch((err) => {
      try {
        exitAltScreen();
        setRaw(false);
      } catch {}
      console.error(err);
      process.exit(1);
    });
  }
}
