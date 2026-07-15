"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Small pure helpers shared across modules
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
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return path.join(os.homedir(), p.slice(2));
  return p;
}

function truncate(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
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

function wrapText(raw, width) {
  const w = Math.max(1, width);
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) {
      out.push("");
      continue;
    }
    for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w));
  }
  return out;
}

function computeViewport(rowsLength, selIndex, prevScroll, viewHeight) {
  if (viewHeight <= 0) return 0;
  let scroll = prevScroll;
  if (selIndex < scroll) scroll = selIndex;
  if (selIndex >= scroll + viewHeight) scroll = selIndex - viewHeight + 1;
  const maxScroll = Math.max(0, rowsLength - viewHeight);
  return Math.min(Math.max(scroll, 0), maxScroll);
}

function isGlobPattern(p) {
  return /[*?[\]]/.test(p);
}

function globSegmentToRegex(seg) {
  let re = "^";
  for (const ch of seg) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re);
}

const GLOB_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
]);

function expandGlobDirs(pattern, maxDepth = 8) {
  const abs = path.resolve(pattern);
  const parsed = path.parse(abs);
  const segments = abs.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const results = new Set();

  function walk(dir, idx, depth) {
    if (idx === segments.length) {
      if (isDir(dir)) results.add(dir);
      return;
    }
    if (depth > maxDepth) return;
    const seg = segments[idx];
    if (seg === "**") {
      walk(dir, idx + 1, depth);
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (!ent.isDirectory() || GLOB_SKIP_DIRS.has(ent.name)) continue;
        walk(path.join(dir, ent.name), idx, depth + 1);
      }
      return;
    }
    if (seg.includes("*") || seg.includes("?")) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const re = globSegmentToRegex(seg);
      for (const ent of entries) {
        if (!ent.isDirectory() || !re.test(ent.name)) continue;
        walk(path.join(dir, ent.name), idx + 1, depth + 1);
      }
      return;
    }
    walk(path.join(dir, seg), idx + 1, depth + 1);
  }

  walk(parsed.root, 0, 0);
  return Array.from(results).sort();
}

function formatRelativeTime(ms) {
  if (!ms) return "unknown time";
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

module.exports = {
  isDir,
  expandHome,
  truncate,
  stripQuotes,
  wrapText,
  computeViewport,
  isGlobPattern,
  expandGlobDirs,
  formatRelativeTime,
};
