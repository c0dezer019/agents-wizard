#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ADD_AGENT_PROMPT_FILE = path.join(__dirname, 'add_agent.md');
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
  return path.join(os.homedir(), '.claude', 'agent-wizard', 'config.json');
}

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
  }
  return {
    name: fm.name || base,
    description: fm.description || '(no description)',
    file: filePath,
    raw,
    mtimeMs,
  };
}

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

function pluginSourceLabel(filePath, root) {
  const rel = path.relative(root, filePath);
  const segments = rel.split(path.sep);
  const agentsIdx = segments.lastIndexOf('agents');
  const sourceSegments = agentsIdx > 0 ? segments.slice(0, agentsIdx) : segments.slice(0, -1);
  return sourceSegments.join('/') || '(unknown)';
}

function dedupeAgents(list) {
  const seen = new Map();
  for (const a of list) {
    const key = a.name + '\u0000' + a.raw;
    const existing = seen.get(key);
    if (!existing || a.mtimeMs > existing.mtimeMs) seen.set(key, a);
  }
  return Array.from(seen.values());
}

function scanAll(cwd, projectAgentsDir, cfg = { trackedPluginAgents: [] }) {
  const userDir = path.join(os.homedir(), '.claude', 'agents');
  const pluginMarketplacesRoot = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces');

  const project = listMdFiles(projectAgentsDir).map(loadAgentFile);
  const user = listMdFiles(userDir).map(loadAgentFile);
  const pluginRaw = findPluginAgentDirs(pluginMarketplacesRoot)
    .flatMap((dir) => listMdFiles(dir))
    .map((f) => ({ ...loadAgentFile(f), source: pluginSourceLabel(f, pluginMarketplacesRoot) }));
  const plugin = dedupeAgents(pluginRaw).sort((a, b) => a.name.localeCompare(b.name));

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

function buildSearchIndex(cwd, cwdAgentsDir, cfg) {
  const entries = [];

  function addProjectDir(dir, label, root) {
    for (const agent of listMdFiles(dir).map(loadAgentFile)) {
      entries.push({ ...agent, scopeKind: 'project', label, root, writable: true });
    }
  }

  addProjectDir(cwdAgentsDir, `${path.basename(cwd)} (cwd)`, cwd);
  for (const root of cfg.bookmarks) {
    if (path.resolve(root) === path.resolve(cwd)) continue;
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
      label: `linked: ${pluginSourceLabel(filePath, pluginMarketplacesRoot)}`,
      root: null,
      writable: true,
      linked: true,
    });
  }

  return entries;
}

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

function supportsUnicode() {
  if (process.platform === 'win32') {
    return Boolean(
      process.env.WT_SESSION ||
        process.env.CI ||
        process.env.TERM_PROGRAM === 'vscode' ||
        process.env.ConEmuTask === '{cmd::Cmder}' ||
        process.env.TERM === 'xterm-256color' ||
        process.env.TERM === 'alacritty'
    );
  }
  return process.env.TERM !== 'linux';
}
const LOGO = supportsUnicode() ? '✦' : '*';

// ---------------------------------------------------------------------------
// Inline image logo (header box)
// ---------------------------------------------------------------------------
function detectImageProtocol() {
  if (!process.stdout.isTTY) return null;
  if (process.env.AGENT_WIZARD_NO_LOGO) return null;
  if (process.env.TMUX || /screen/.test(process.env.TERM || '')) return null;
  if (process.env.TERM === 'xterm-kitty' || process.env.KITTY_WINDOW_ID) return 'kitty';
  if (
    process.env.TERM_PROGRAM === 'iTerm.app' ||
    process.env.TERM_PROGRAM === 'WezTerm' ||
    process.env.TERM_PROGRAM === 'mintty' ||
    process.env.KONSOLE_VERSION
  ) {
    return 'iterm';
  }
  return null;
}

const LOGO_PIXEL_WIDTH = 176;
const LOGO_PIXEL_HEIGHT = 164;

function loadLogoBase64(repoDir) {
  try {
    return fs.readFileSync(path.join(repoDir, 'assets', 'logo.png')).toString('base64');
  } catch {
    return null;
  }
}

function itermImageEscape(base64, cols, rows) {
  return `\x1B]1337;File=inline=1;width=${cols};height=${rows};preserveAspectRatio=1:${base64}\x07`;
}

function kittyImageEscape(base64, cols, rows) {
  const CHUNK = 4096;
  let out = '';
  for (let i = 0; i < base64.length; i += CHUNK) {
    const chunk = base64.slice(i, i + CHUNK);
    const more = i + CHUNK < base64.length ? 1 : 0;
    const controls = i === 0 ? `a=T,f=100,c=${cols},r=${rows},m=${more}` : `m=${more}`;
    out += `\x1B_G${controls};${chunk}\x1B\\`;
  }
  return out;
}

function computeLogoGutter(imgRows, termWidth) {
  const cols = Math.round(imgRows * 2 * (LOGO_PIXEL_WIDTH / LOGO_PIXEL_HEIGHT));
  const clamped = Math.max(4, Math.min(cols, 24));
  const minTextWidth = MIN_DESC_WIDTH + 10;
  if (termWidth - clamped - 6 < minTextWidth) return 0;
  return clamped;
}

// Save/restore cursor around an absolute-position draw, same trick
// renderInlineLogoEscape (header box) already relies on — wherever the image
// protocol leaves the cursor after drawing doesn't matter, since control
// always returns to exactly where it was before this ran.
function placedImageEscape(protocol, base64, cols, rows, row, col) {
  const body = protocol === 'kitty' ? kittyImageEscape(base64, cols, rows) : itermImageEscape(base64, cols, rows);
  return `${ESC}s${ESC}${row};${col}H${body}${ESC}u`;
}

function renderInlineLogoEscape(protocol, base64, cols, rows) {
  return placedImageEscape(protocol, base64, cols, rows, 2, 3);
}

// ---------------------------------------------------------------------------
// Inline image logo (agent-creation flow flourish)
// ---------------------------------------------------------------------------
// assets/spell.png (wizard casting) shows up at a random on-screen spot
// during createFlow's prompts (see pickSpellSlot/createFlow) — one new
// random spot per question, held fixed for that question's own redraws
// (every keystroke repaints, so picking fresh per-frame would make it
// jitter). Same capability check/fallback as the header logo: null
// anywhere the image logo itself wouldn't show (see detectImageProtocol),
// so this never shows up somewhere the header logo doesn't.
const SPELL_PIXEL_WIDTH = 200;
const SPELL_PIXEL_HEIGHT = 171;

function loadSpellBase64(repoDir) {
  try {
    return fs.readFileSync(path.join(repoDir, 'assets', 'spell.png')).toString('base64');
  } catch {
    return null;
  }
}

function pickSpellSlot(imageLogo, spellBase64) {
  if (!imageLogo || !spellBase64) return null;
  const termCols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const rows = Math.max(4, Math.min(10, Math.floor(termRows * 0.35)));
  const cols = Math.max(6, Math.min(termCols - 4, Math.round(rows * 2 * (SPELL_PIXEL_WIDTH / SPELL_PIXEL_HEIGHT))));
  if (termRows - rows < 2 || termCols - cols < 2) return null;
  const row = 1 + Math.floor(Math.random() * (termRows - rows - 1));
  const col = 1 + Math.floor(Math.random() * (termCols - cols - 1));
  return { protocol: imageLogo.protocol, base64: spellBase64, cols, rows, row, col };
}

function renderSpellEscape(slot) {
  return slot ? placedImageEscape(slot.protocol, slot.base64, slot.cols, slot.rows, slot.row, slot.col) : '';
}

function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function getRecentReleaseNotes(repoDir, n) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(repoDir, 'RELEASE_NOTES.md'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- '))
    .slice(0, n)
    .map((line) => line.slice(2).trim());
}

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─' };
// leftPad pushes the label bar further right along the border before it
// starts — used to shift the top border's title past the logo/divider when
// the inline image logo is showing (see renderHeaderBox/computeLogoGutter),
// so it reads as sitting to the right of the image rather than overlapping
// the left corner above it.
function buildLabeledBorder(leftCorner, rightCorner, label, width, leftPad) {
  if (!label) return dim(leftCorner + BOX.h.repeat(width - 2) + rightCorner);
  const pad = Math.min(Math.max(0, leftPad || 0), Math.max(0, width - 3));
  const maxLabelBar = Math.max(0, width - 3 - pad);
  const labelBar = truncate(` ${label} `, maxLabelBar);
  const dashes = Math.max(0, maxLabelBar - labelBar.length);
  return dim(leftCorner + BOX.h.repeat(1 + pad)) + bold(labelBar) + dim(BOX.h.repeat(dashes) + rightCorner);
}

function renderHeaderBox(title, contentLines, termWidth, bottomLabel, logoGutter) {
  const width = Math.max(24, termWidth);
  const inner = width - 4;
  const top = buildLabeledBorder(BOX.tl, BOX.tr, title, width, logoGutter ? logoGutter + 1 : 0);
  const bottom = buildLabeledBorder(BOX.bl, BOX.br, bottomLabel, width);
  const gutter = logoGutter || 0;
  const textInner = Math.max(0, inner - gutter - (gutter ? 2 : 0));
  const mid = contentLines.map((l) => {
    const divider = gutter ? ' '.repeat(gutter) + dim('│ ') : '';
    return dim('│ ') + divider + truncate(l, textInner).padEnd(textInner) + dim(' │');
  });
  return [top, ...mid, bottom];
}

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
  if (enabled) process.stdin.resume();
}

const keyQueue = [];
let keyResolver = null;

function onKeypressEvent(str, key) {
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

const RESIZE_KEY = { name: '__resize__', str: '' };
function triggerRepaint() {
  if (keyResolver) {
    const resolve = keyResolver;
    keyResolver = null;
    resolve(RESIZE_KEY);
  } else if (keyQueue[keyQueue.length - 1] !== RESIZE_KEY) {
    keyQueue.push(RESIZE_KEY);
  }
}

function computeViewport(rowsLength, selIndex, prevScroll, viewHeight) {
  if (viewHeight <= 0) return 0;
  let scroll = prevScroll;
  if (selIndex < scroll) scroll = selIndex;
  if (selIndex >= scroll + viewHeight) scroll = selIndex - viewHeight + 1;
  const maxScroll = Math.max(0, rowsLength - viewHeight);
  return Math.min(Math.max(scroll, 0), maxScroll);
}

function listViewHeight(headerLineCount) {
  const termRows = process.stdout.rows || 24;
  const chrome = 2 + headerLineCount + 1 + 1 + 1 + 2 + 2;
  return Math.max(3, termRows - chrome);
}

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

function stripNoteDate(note) {
  return note.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '');
}

function headerContentLines(data, recentNotes) {
  const lines = [`user: ${data.user.dir}`, 'recent changes:'];
  if (recentNotes.length) {
    for (const note of recentNotes) lines.push(`  • ${stripNoteDate(note)}`);
  } else {
    lines.push('  (no RELEASE_NOTES.md found in this checkout)');
  }
  return lines;
}

function renderList(data, tabIndex, selIndex, scrollOffset, viewHeight, status, projectMode, cfg, recentNotes, imageLogo) {
  const tabKey = TABS[tabIndex];
  const rows = rowsFor(data, tabKey, projectMode, cfg);
  let out = clearScreen();
  const projectTag = projectMode === 'bookmark-project' ? '  (bookmark project)' : '';
  const headerWidth = process.stdout.columns || 80;
  const contentLines = headerContentLines(data, recentNotes);
  const gutter = imageLogo ? computeLogoGutter(contentLines.length, headerWidth) : 0;
  const headerLines = renderHeaderBox(
    `${LOGO} Agent Wizard`,
    contentLines,
    headerWidth,
    `cwd: ${data.project.dir}${projectTag}`,
    gutter
  );
  if (gutter) out += renderInlineLogoEscape(imageLogo.protocol, imageLogo.base64, gutter, contentLines.length);
  out += headerLines.join('\n') + '\n\n';

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
    else modeHint = '   Esc: bookmarks   b: cwd';
  }
  const editHint = data[tabKey].writable && !(tabKey === 'project' && projectMode === 'bookmarks') ? '   e edit   x delete' : '';
  const viewHint = tabKey === 'project' && projectMode === 'bookmarks' ? '' : '   v view';
  const copyHint = tabKey === 'project' && projectMode === 'bookmarks' ? '' : '   c copy to project';
  const trackHint = tabKey === 'plugin' ? '   u track/untrack → User tab' : '';
  out +=
    '\n' +
    dim(
      '←/→ tabs   ↑/↓ move   Enter run' +
        viewHint +
        copyHint +
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

function renderSearch(query, results, selIndex, scrollOffset, viewHeight, status) {
  let out = clearScreen();
  out += bold('Agent Wizard — search') + '\n\n';
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

function renderMenu(title, subtitleLines, options, idx, spellSlot) {
  let out = clearScreen() + renderSpellEscape(spellSlot);
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

function pauseKeyCapture() {
  process.stdin.removeListener('keypress', onKeypressEvent);
}
function resumeKeyCapture() {
  keyQueue.length = 0;
  process.stdin.on('keypress', onKeypressEvent);
}

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

async function askLine(promptText, spellSlot) {
  let buffer = '';
  for (;;) {
    let out = clearScreen() + renderSpellEscape(spellSlot);
    out += bold('Agent Wizard') + '\n\n';
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
  // shell: true on win32 so .cmd/.bat editor shims (e.g. VS Code's `code`
  // launcher) resolve — spawnSync without a shell can fail to find these
  // on Windows even when the editor works fine from an interactive prompt.
  const res = spawnSync(editor, [filePath], { stdio: 'inherit', shell: process.platform === 'win32' });
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

function runAgentSession(agent) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  process.stdout.write(
    `\nStarting claude --agent ${agent.name} (exit the session normally to return to the wizard)...\n\n`
  );
  // shell: true on win32 — global npm installs commonly expose `claude` as a
  // .cmd shim, which spawnSync can fail to resolve without a shell even
  // though it's on PATH.
  const res = spawnSync('claude', ['--agent', agent.name], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
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

function toggleTrackedPluginAgent(cfg, agent) {
  return cfg.trackedPluginAgents.includes(agent.file) ? untrackPluginAgent(cfg, agent) : trackPluginAgent(cfg, agent);
}

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
        const deleteLabel = row.linked ? 'Untrack from User tab' : 'Delete';
        const trackLabel = cfg.trackedPluginAgents.includes(row.file) ? 'Untrack from User tab' : 'Track into User tab';
        const copyLabel = 'Copy to project…';
        const options = row.writable
          ? ['Launch', 'View', 'Edit', deleteLabel, copyLabel]
          : row.scopeKind === 'plugin'
            ? ['Launch', 'View', trackLabel, copyLabel]
            : ['Launch', 'View', copyLabel];
        const choice = await pickOption(row.name, [`[${row.scopeKind}] ${row.label}`, row.description], options);
        if (choice === 'Launch') status = runAgentSession(row);
        else if (choice === 'View') await viewFile(row);
        else if (choice === 'Edit') status = await editAgent(row);
        else if (choice === copyLabel) status = await copyAgentFlow(row, cwd, cfg);
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

async function pickOption(title, subtitleLines, options, spellSlot) {
  let idx = 0;
  for (;;) {
    renderMenu(title, subtitleLines, options, idx, spellSlot);
    setRaw(true);
    const key = await waitForKey();
    if (key.ctrl && key.name === 'c') process.exit(0);
    else if (key.name === 'up') idx = (idx + options.length - 1) % options.length;
    else if (key.name === 'down') idx = (idx + 1) % options.length;
    else if (key.name === 'escape' || key.name === 'q') return null;
    else if (key.name === 'return') return options[idx];
  }
}

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

async function pickCopyTarget(cwd, cfg) {
  const roots = [cwd, ...cfg.bookmarks];
  const options = [`${path.basename(cwd)} (cwd)`, ...cfg.bookmarks, 'Type a path…'];
  const choice = await pickOption('Copy to which project?', [], options);
  if (choice === null) return null;
  if (choice === 'Type a path…') return addProjectFolder(cwd, cfg);
  return roots[options.indexOf(choice)];
}

async function copyAgentFlow(agent, cwd, cfg) {
  const targetRoot = await pickCopyTarget(cwd, cfg);
  if (!targetRoot) return 'Copy cancelled.';
  const targetDir = path.join(targetRoot, '.claude', 'agents');
  const targetFile = path.join(targetDir, `${agent.name}.md`);
  if (path.resolve(targetFile) === path.resolve(agent.file)) {
    return `"${agent.name}" is already at ${targetFile} — nothing to copy.`;
  }
  if (fs.existsSync(targetFile)) {
    const confirm = await askLine(`${targetFile} already exists. Overwrite? (y/N): `);
    if (confirm.trim().toLowerCase() !== 'y') return 'Copy cancelled.';
  }
  const dirExisted = isDir(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(agent.file, targetFile);
  let note = `Copied ${agent.name} to ${targetFile}.`;
  if (!dirExisted) note += ' New agents/ directory — restart Claude Code to pick it up.';
  return note;
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

function renderStatusScreen(label) {
  process.stdout.write(`${clearScreen()}\n${label}\n`);
}

function runClaudeGenerate(promptText, { systemPrompt, systemPromptFile, label } = {}) {
  // stdio stays piped (not 'inherit'), so this call never touches the tty —
  // no need to drop out of the alt screen / raw mode for it, just repaint
  // a status screen in place and stay in the wizard's UI.
  renderStatusScreen(label || 'Calling claude...');
  const args = ['-p', promptText, '--tools', ''];
  if (systemPromptFile) args.push('--system-prompt-file', systemPromptFile);
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  // shell: true on win32 — see runAgentSession for why (.cmd shim resolution).
  const res = spawnSync('claude', args, {
    encoding: 'utf8',
    timeout: 120000,
    shell: process.platform === 'win32',
  });
  return res;
}

function describeClaudeError(res) {
  if (res.error && res.error.code === 'ENOENT') return 'claude CLI not found in PATH';
  if (res.error) return res.error.message;
  if (res.signal === 'SIGTERM') return 'claude timed out';
  const stderr = (res.stderr || '').trim();
  return stderr ? stderr.split('\n').slice(0, 3).join(' ') : `claude exited with status ${res.status}`;
}

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

function runClaudeInteractive(promptText, systemPromptFile) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  process.stdout.write(
    '\nStarting an interactive claude session to finish this agent together ' +
      '(exit the session normally, e.g. Ctrl+D, to return to the wizard)...\n\n'
  );
  // shell: true on win32 — see runAgentSession for why (.cmd shim resolution).
  const res = spawnSync('claude', ['--system-prompt-file', systemPromptFile, promptText], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
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

async function manualCreateFallback(scopeDir, target, name, warning, imageLogo, spellBase64) {
  const description = await askLine(
    'One-line description (this is the delegation trigger Claude reads): ',
    pickSpellSlot(imageLogo, spellBase64)
  );
  const dirExisted = isDir(scopeDir);
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(target, buildManualTemplate(name, description), 'utf8');
  const { editor, res } = openEditor(target);
  let note = `${warning} Created ${target}.`;
  if (res.error) note += ` (Could not launch editor "${editor}": ${res.error.message})`;
  if (!dirExisted) note += ' New agents/ directory — restart Claude Code to pick it up.';
  return note;
}

async function createFlow(data, tabKey, imageLogo, spellBase64) {
  const scopeDir = tabKey === 'project' ? data.project.dir : path.join(os.homedir(), '.claude', 'agents');
  const spellSlot = () => pickSpellSlot(imageLogo, spellBase64); // fresh random spot per question, held fixed for that question's own redraws

  const name = await askLine('New agent name (lowercase-hyphens, e.g. code-reviewer): ', spellSlot());
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
    'Role — what should this agent be? (e.g. "code reviewer", "database migration specialist"): ',
    spellSlot()
  );
  const seniority = await askLine('Seniority / experience level? (e.g. junior, senior, principal): ', spellSlot());
  const tasks = await askLine('General tasks it will perform (a sentence, or comma-separated list): ', spellSlot());

  const descResult = await generateDescription(role, seniority, tasks);
  if (!descResult.ok) {
    return manualCreateFallback(
      scopeDir,
      target,
      name,
      `Couldn't draft a description via claude (${descResult.error}).`,
      imageLogo,
      spellBase64
    );
  }
  const { description } = descResult;

  const finishChoice = await pickOption(
    'How should claude finish drafting this file?',
    [`name: ${name}`, `description: "${description}"`],
    ['Auto-draft with claude -p', 'Open interactive claude session', 'Skip — use manual template'],
    spellSlot()
  );

  const dirExisted = isDir(scopeDir);
  fs.mkdirSync(scopeDir, { recursive: true });

  let note;
  if (finishChoice === 'Open interactive claude session') {
    const prompt = buildInteractivePrompt(target, name, description, role, seniority, tasks);
    runClaudeInteractive(prompt, ADD_AGENT_INTERACTIVE_PROMPT_FILE);
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
      fs.writeFileSync(target, buildManualTemplate(name, description), 'utf8');
      note = `Created ${target} with a manual template — claude couldn't draft the full file (${fileResult.error}).`;
    }
  } else {
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

function stateKey(tabKey, projectMode) {
  if (tabKey !== 'project') return tabKey;
  if (projectMode === 'bookmarks') return 'projectBookmarks';
  if (projectMode === 'bookmark-project') return 'projectBookmarkProject';
  return 'project';
}

async function listLoop() {
  const cwd = process.cwd();
  const cfg = loadConfig();
  const recentNotes = getRecentReleaseNotes(__dirname, 4);
  const protocol = detectImageProtocol();
  const logoBase64 = protocol ? loadLogoBase64(__dirname) : null;
  const imageLogo = logoBase64 ? { protocol, base64: logoBase64 } : null;
  const spellBase64 = protocol ? loadSpellBase64(__dirname) : null;
  const cwdAgentsDir = path.join(cwd, '.claude', 'agents');
  let selectedBookmarkRoot = null;
  let projectMode = 'cwd';
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
    const viewHeight = listViewHeight(headerContentLines(data, recentNotes).length);
    scrollOffset[sKey] = computeViewport(rows.length, selIndex[sKey], scrollOffset[sKey], viewHeight);

    renderList(data, tabIndex, selIndex[sKey], scrollOffset[sKey], viewHeight, status, projectMode, cfg, recentNotes, imageLogo);
    status = '';

    setRaw(true);
    const key = await waitForKey();

    if ((key.ctrl && key.name === 'c') || key.name === 'q') return;
    else if (key.name === 'left') tabIndex = (tabIndex + TABS.length - 1) % TABS.length;
    else if (key.name === 'right') tabIndex = (tabIndex + 1) % TABS.length;
    else if (key.name === 'up') selIndex[sKey] = Math.max(0, selIndex[sKey] - 1);
    else if (key.name === 'down') selIndex[sKey] = Math.min(rows.length - 1, selIndex[sKey] + 1);
    else if (key.name === 'escape' && tabKey === 'project' && projectMode === 'bookmark-project') {
      projectMode = 'bookmarks';
    } else if (key.name === 'b' && tabKey === 'project') {
      if (projectMode === 'cwd') {
        projectMode = selectedBookmarkRoot ? 'bookmark-project' : 'bookmarks';
      } else if (projectMode === 'bookmarks') {
        selectedBookmarkRoot = null;
        projectMode = 'cwd';
      } else {
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
          status = await createFlow(data, tabKey, imageLogo, spellBase64);
        } else if (!row.virtual) {
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
    } else if (key.name === 'c' && !(tabKey === 'project' && projectMode === 'bookmarks')) {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) status = await copyAgentFlow(row, cwd, cfg);
    } else if (key.str === 'u' && tabKey === 'plugin') {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) status = toggleTrackedPluginAgent(cfg, row);
    } else if (key.str === '/') {
      await searchFlow(cwd, cwdAgentsDir, cfg);
    } else if (key.str === '?') {
      await showHelp();
    }
  }
}

function runUpdate() {
  const repoDir = __dirname;
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.error(`error: ${repoDir} is not a git checkout (no .git found) — can't update.`);
    process.exit(1);
  }
  console.log(`Updating agent-wizard in ${repoDir}...`);
  const res = spawnSync('git', ['-C', repoDir, 'pull'], { stdio: 'inherit' });
  if (res.error) {
    console.error(`error: failed to run git: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

// Windows Terminal (ConPTY) covers every escape sequence this tool relies on
// — raw mode, alt-screen, cursor positioning, colors — except the inline
// image protocols (kitty/iTerm), which it doesn't implement. WezTerm covers
// those too. Neither is required to run the tool (everything still degrades
// cleanly — see detectImageProtocol), so this is a one-time heads-up, not a
// hard gate. Set AGENT_WIZARD_SKIP_TERM_CHECK to silence it permanently.
function checkWindowsTerminalRecommendation() {
  if (process.platform !== 'win32') return Promise.resolve();
  if (process.env.AGENT_WIZARD_SKIP_TERM_CHECK) return Promise.resolve();
  const inWindowsTerminal = Boolean(process.env.WT_SESSION);
  const inWezTerm = process.env.TERM_PROGRAM === 'WezTerm';
  if (inWindowsTerminal || inWezTerm) return Promise.resolve();

  console.log(
    [
      '',
      'agent-wizard works best in Windows Terminal (recommended) or WezTerm.',
      "You're running in a different console — the TUI will still work, but",
      'rendering may be inconsistent, and neither the logo image nor spell',
      'animation will show (Windows Terminal never renders these either;',
      'WezTerm is the only Windows terminal that supports both).',
      '',
      '  Windows Terminal: https://aka.ms/terminal',
      '  WezTerm:          https://wezterm.org',
      '',
      'Set AGENT_WIZARD_SKIP_TERM_CHECK=1 to silence this in future.',
      '',
      'Press any key to continue anyway...',
    ].join('\n')
  );
  return new Promise((resolve) => {
    setRaw(true);
    process.stdin.once('data', () => {
      setRaw(false);
      resolve();
    });
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('agent-wizard needs an interactive terminal (TTY). Run it directly, not piped.');
    process.exit(1);
  }
  await checkWindowsTerminalRecommendation();
  readline.emitKeypressEvents(process.stdin);
  resumeKeyCapture();
  enterAltScreen();
  process.stdout.on('resize', triggerRepaint);
  try {
    await listLoop();
  } finally {
    process.stdout.removeListener('resize', triggerRepaint);
    exitAltScreen();
    setRaw(false);
  }
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
