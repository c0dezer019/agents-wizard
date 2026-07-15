"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { expandHome, truncate } = require("./util");

// ---------------------------------------------------------------------------
// Talks to Claude Code's own transcript storage, but only for the one fact
// that's actually documented and stable: *where* it lives and that the
// session ID is the .jsonl filename. https://code.claude.com/docs/en/sessions
//
// agent-wizard keeps its own log of what it launched (see lib/session-log.js)
// — this module is only used to recover the exact session ID Claude Code
// assigned right after a spawn returns, since spawnSync (stdio: "inherit")
// gives no other way to learn it. Nothing here parses the per-line jsonl
// schema, which Anthropic documents as internal/unstable.
// ---------------------------------------------------------------------------

function encodeProjectPath(root) {
  return path.resolve(root).replace(/[^A-Za-z0-9]/g, "-");
}

function claudeProjectsRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? expandHome(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

function claudeProjectDir(root) {
  return path.join(claudeProjectsRoot(), encodeProjectPath(root));
}

// Best-effort: the newest .jsonl file in this project's transcript dir with
// mtime >= sinceMs. Used right after a spawn returns to identify which
// session file it just wrote/touched. Returns null if none found (e.g. the
// `claude` CLI is missing, or the session dir hasn't shown up yet).
function detectSessionId(root, sinceMs) {
  const dir = claudeProjectDir(root);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    const filePath = path.join(dir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= sinceMs && (!best || mtimeMs > best.mtimeMs)) {
      best = { sessionId: path.basename(f, ".jsonl"), mtimeMs };
    }
  }
  return best ? best.sessionId : null;
}

function readJsonlEntries(filePath, maxLines) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const slice = maxLines ? lines.slice(0, maxLines) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
      // eslint-disable-next-line no-empty
    } catch {}
  }
  return out;
}

// Best-effort: first user-authored message text, for a one-line preview in
// the Sessions tab. Display-only — never used to identify a session (that's
// always the sessionId from our own log) or to guess which agent it used
// (that's always the log's own agentName). If the schema shifts under us,
// worst case this just comes back empty and the row shows without a preview.
function readSessionSummary(root, sessionId, maxChars = 80) {
  const filePath = path.join(claudeProjectDir(root), `${sessionId}.jsonl`);
  const entries = readJsonlEntries(filePath, 40);
  for (const e of entries) {
    if (!e || e.type !== "user" || !e.message) continue;
    const content = e.message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const textBlock = content.find((c) => c && c.type === "text" && c.text);
      if (textBlock) text = textBlock.text;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text) return truncate(text, maxChars);
  }
  return null;
}

module.exports = { claudeProjectDir, detectSessionId, readSessionSummary };
