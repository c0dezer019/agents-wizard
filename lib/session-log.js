"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// agent-wizard's own record of sessions it launched: which agent (if any)
// was used, which project directory, and when. This is the "Sessions" tab's
// source of truth — unlike parsing Claude Code's internal transcript
// format, this is data agent-wizard itself wrote, so it can't drift out
// from under a Claude Code update. The one thing still borrowed from Claude
// Code is the session ID itself (see lib/sessions.js: detectSessionId),
// since that's needed to call `claude --resume <id>`.
// ---------------------------------------------------------------------------

const MAX_RECORDS = 300;

function sessionLogFile() {
  return path.join(os.homedir(), ".claude", "agent-wizard", "sessions.json");
}

function isValidRecord(r) {
  return (
    r &&
    typeof r === "object" &&
    typeof r.sessionId === "string" &&
    typeof r.cwd === "string" &&
    typeof r.lastActiveAt === "number"
  );
}

function loadSessionLog() {
  try {
    const raw = fs.readFileSync(sessionLogFile(), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.sessions) ? data.sessions.filter(isValidRecord) : [];
  } catch {
    return [];
  }
}

function saveSessionLog(sessions) {
  const file = sessionLogFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const trimmed = sessions
    .slice()
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, MAX_RECORDS);
  fs.writeFileSync(file, JSON.stringify({ sessions: trimmed }, null, 2) + "\n", "utf8");
}

// Records that `sessionId` (in `cwd`, using `agentName` — null for none) is
// either new or just became active again. Called right after every spawn
// (fresh launch or resume) that successfully produced a session ID.
function upsertSessionRecord({ sessionId, cwd, agentName }) {
  const root = path.resolve(cwd);
  const sessions = loadSessionLog();
  const now = Date.now();
  const idx = sessions.findIndex(
    (s) => s.sessionId === sessionId && path.resolve(s.cwd) === root,
  );
  if (idx === -1) {
    sessions.push({
      sessionId,
      cwd: root,
      agentName: agentName || null,
      startedAt: now,
      lastActiveAt: now,
    });
  } else {
    sessions[idx] = {
      ...sessions[idx],
      agentName: agentName || null,
      lastActiveAt: now,
    };
  }
  saveSessionLog(sessions);
}

function sessionsForCwd(cwd, limit = 100) {
  const root = path.resolve(cwd);
  return loadSessionLog()
    .filter((s) => path.resolve(s.cwd) === root)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, limit);
}

module.exports = {
  sessionLogFile,
  loadSessionLog,
  saveSessionLog,
  upsertSessionRecord,
  sessionsForCwd,
};
