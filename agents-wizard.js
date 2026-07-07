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
 *           (Project/User only)
 *   b       (Project tab only) jump between cwd and bookmarks — see below
 *   Esc     (Project tab, inside an entered bookmark project) back to the
 *           bookmarks list
 *   d       (Project tab, bookmarks list only) remove the highlighted bookmark
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
 *   User    — ~/.claude/agents/ (personal, all projects). Writable.
 *   Plugin  — always empty. This used to scan every agents/ directory under
 *             ~/.claude/plugins/cache/, but that directory keeps orphaned
 *             copies from previous plugin versions on disk for ~7 days after
 *             an update, so it isn't a reliable "what's actually installed"
 *             source — excluded rather than shown unreliably. Still
 *             read-only (nothing here would be editable anyway).
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

function loadConfig() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    const data = JSON.parse(raw);
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks.filter((b) => typeof b === 'string') : [];
    return { bookmarks };
  } catch {
    return { bookmarks: [] };
  }
}

function saveConfig(cfg) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ bookmarks: cfg.bookmarks }, null, 2) + '\n', 'utf8');
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

// Plugin cache dirs keep the previous version of a plugin on disk for ~7 days
// after an update (see Claude Code docs on plugin caching) — an "orphaned"
// copy that a plain filesystem walk can't distinguish from the current one.
// Same name + identical file content is the practical signal that two hits
// are the same agent from two version dirs, not two distinct agents that
// happen to share a name. Keep whichever copy has the newest mtime.
function dedupeAgents(list) {
  const seen = new Map();
  for (const a of list) {
    const key = a.name + ' ' + a.raw;
    const existing = seen.get(key);
    if (!existing || a.mtimeMs > existing.mtimeMs) seen.set(key, a);
  }
  return Array.from(seen.values());
}

function findPluginAgentDirs(cacheRoot, maxDepth = 6) {
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
  walk(cacheRoot, 0);
  return found;
}

function scanAll(cwd, projectAgentsDir) {
  const userDir = path.join(os.homedir(), '.claude', 'agents');

  const project = listMdFiles(projectAgentsDir).map(loadAgentFile);
  const user = listMdFiles(userDir).map(loadAgentFile);

  // Plugin agents are no longer scanned from ~/.claude/plugins/cache: that
  // directory keeps orphaned copies from previous plugin versions on disk
  // for ~7 days after an update (see findPluginAgentDirs/dedupeAgents),
  // which made it an unreliable "what's actually installed" source. Always
  // empty for now.
  const plugin = [];

  return {
    project: { dir: projectAgentsDir, agents: project, writable: true },
    user: { dir: userDir, agents: user, writable: true },
    plugin: { dir: null, agents: plugin, writable: false },
  };
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

function enterAltScreen() {
  process.stdout.write('\x1B[?1049h\x1B[?25l');
}
function exitAltScreen() {
  process.stdout.write('\x1B[?25h\x1B[?1049l');
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
    const visible = rows.slice(scrollOffset, scrollOffset + viewHeight);
    visible.forEach((row, i) => {
      const absoluteIndex = scrollOffset + i;
      const label = row.virtual
        ? row.label
        : `${row.name}  ${dim('— ' + truncate(row.description, 60))}`;
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
  out +=
    '\n' +
    dim('←/→ tabs   ↑/↓ move   Enter run' + viewHint + editHint + '   ? help   q quit' + modeHint + scrollHint) +
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

function renderViewer(agent, lines, scroll, viewHeight) {
  let out = clearScreen();
  out += bold(agent.file) + '\n\n';
  out += lines.slice(scroll, scroll + viewHeight).join('\n') + '\n';
  const last = Math.min(scroll + viewHeight, lines.length);
  out +=
    '\n' +
    dim(`↑/↓ scroll (${lines.length ? scroll + 1 : 0}-${last}/${lines.length})   Esc/q back`) +
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
  const lines = agent.raw.split(/\r?\n/);
  let scroll = 0;
  for (;;) {
    const rows = process.stdout.rows || 24;
    const viewHeight = Math.max(3, rows - 5);
    renderViewer(agent, lines, scroll, viewHeight);
    setRaw(true);
    const key = await waitForKey();
    if (key.name === 'up') scroll = Math.max(0, scroll - 1);
    else if (key.name === 'down') scroll = Math.min(Math.max(0, lines.length - viewHeight), scroll + 1);
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
    const data = scanAll(cwd, currentProjectAgentsDir());
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
      if (row && !row.virtual) status = await deleteAgent(row);
    } else if (key.str === '?') {
      // Global — doesn't depend on tab/row, so no row lookup needed.
      await showHelp();
    }
  }
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
  process.stdout.write('\x1B[?25h\x1B[?1049l');
});

module.exports = {
  parseFrontmatter,
  loadAgentFile,
  findPluginAgentDirs,
  dedupeAgents,
  computeViewport,
  scanAll,
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
  main().catch((err) => {
    try {
      exitAltScreen();
      setRaw(false);
    } catch {}
    console.error(err);
    process.exit(1);
  });
}
