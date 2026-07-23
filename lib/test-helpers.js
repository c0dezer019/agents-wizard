"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Shared test fixtures. Not a *.test.js file itself — imported by the actual
// test files. Every function here is side-effect-isolated to a caller-owned
// temp directory; nothing touches the real $HOME or cwd.
// ---------------------------------------------------------------------------

// Redirects os.homedir() (via $HOME, which every homedir() call in this repo
// reads lazily — see lib/scan.js, lib/config.js, lib/teams.js) at a fresh
// mkdtemp for the duration of a test, and restores it after. Without this,
// tests that exercise buildSearchIndex/loadTeams/etc. would read the real
// developer machine's ~/.claude and produce non-deterministic results.
function withTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aw-test-home-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE; // Windows os.homedir() fallback
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home,
    restore() {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function mkTempDir(prefix = "aw-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Writes a minimal valid agent .md with frontmatter into `dir` (created if
// missing), returns the absolute file path.
function writeAgentFile(dir, basename, { name, description = "test agent", body = "Body\n" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${basename}.md`);
  const fm = [`name: ${name || basename}`, `description: ${description}`].join("\n");
  fs.writeFileSync(file, `---\n${fm}\n---\n${body}`, "utf8");
  return file;
}

// Creates `<root>/.claude/agents` and writes an agent file into it. Returns
// { root, agentsDir, file }.
function makeProjectWithAgent(root, basename, opts) {
  const agentsDir = path.join(root, ".claude", "agents");
  const file = writeAgentFile(agentsDir, basename, opts);
  return { root, agentsDir, file };
}

module.exports = { withTempHome, mkTempDir, writeAgentFile, makeProjectWithAgent };
