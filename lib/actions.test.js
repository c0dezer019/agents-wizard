"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { withTempHome, mkTempDir, makeProjectWithAgent, writeAgentFile } = require("./test-helpers");
const { buildSearchIndex } = require("./scan");
const {
  resolveRef,
  buildRosterBlock,
  regenerateOrchestratorPrompt,
  stripOrchestratorPromptBlock,
  buildAssignablePool,
} = require("./actions");

function withIsolation(fn) {
  return async () => {
    const th = withTempHome();
    try {
      await fn(th);
    } finally {
      th.restore();
    }
  };
}

function refFromEntry(entry) {
  return { name: entry.name, scopeKind: entry.scopeKind, file: entry.file, description: entry.description };
}

// ---------------------------------------------------------------------------
// resolveRef — project scope (gated by presence in the *current* search
// index, i.e. current session's cwd/bookmarks — see lib/actions.js)
// ---------------------------------------------------------------------------

test("resolveRef: project ref resolves ok when its root is the current cwd", withIsolation(() => {
  const cwd = mkTempDir("aw-cwd-");
  const { agentsDir, file } = makeProjectWithAgent(cwd, "foo");
  const cfg = { bookmarks: [], trackedPluginAgents: [] };
  const idx = buildSearchIndex(cwd, agentsDir, cfg);
  const ref = { name: "foo", scopeKind: "project", file, description: "test agent" };

  const result = resolveRef(ref, idx);

  assert.equal(result.status, "ok");
  assert.equal(result.agent.file, file);
}));

test("resolveRef: project ref is inaccessible when session's cwd/bookmarks don't include its root", withIsolation(() => {
  const projectRoot = mkTempDir("aw-proj-");
  const { file } = makeProjectWithAgent(projectRoot, "foo");
  const ref = { name: "foo", scopeKind: "project", file, description: "test agent" };

  // Different, unrelated session — file exists on disk, but this session
  // never bookmarked/cd'd into projectRoot.
  const unrelatedCwd = mkTempDir("aw-unrelated-");
  const cfg = { bookmarks: [], trackedPluginAgents: [] };
  const idx = buildSearchIndex(unrelatedCwd, path.join(unrelatedCwd, ".claude", "agents"), cfg);

  const result = resolveRef(ref, idx);

  assert.equal(result.status, "inaccessible");
  // Must not fall back to trusting the raw file path.
  assert.ok(fs.existsSync(ref.file), "sanity: file genuinely still exists on disk");
}));

test("resolveRef: project ref is inaccessible even when its root is bookmarked but the agent dir is empty/gone", withIsolation(() => {
  const projectRoot = mkTempDir("aw-proj-");
  const { file, agentsDir } = makeProjectWithAgent(projectRoot, "foo");
  const ref = { name: "foo", scopeKind: "project", file, description: "test agent" };

  fs.rmSync(agentsDir, { recursive: true, force: true });
  const cfg = { bookmarks: [projectRoot], trackedPluginAgents: [] };
  const otherCwd = mkTempDir("aw-other-cwd-");
  const idx = buildSearchIndex(otherCwd, path.join(otherCwd, ".claude", "agents"), cfg);

  const result = resolveRef(ref, idx);
  assert.equal(result.status, "inaccessible");
}));

test("resolveRef: project ref reports renamed when frontmatter name changed but file path is unchanged", withIsolation(() => {
  const cwd = mkTempDir("aw-cwd-");
  const { agentsDir, file } = makeProjectWithAgent(cwd, "foo", { name: "foo" });
  const cfg = { bookmarks: [], trackedPluginAgents: [] };
  const ref = { name: "foo", scopeKind: "project", file, description: "test agent" };

  // Rename the agent's frontmatter `name`, but keep the same file path —
  // buildSearchIndex will still find it (same basename search), and it's
  // still in the accessible root, so resolveRef should report "renamed",
  // not "inaccessible" or "ok".
  fs.writeFileSync(file, "---\nname: foo-renamed\ndescription: test agent\n---\nBody\n", "utf8");
  const idx = buildSearchIndex(cwd, agentsDir, cfg);

  const result = resolveRef(ref, idx);

  assert.equal(result.status, "renamed");
  assert.equal(result.agent.name, "foo-renamed");
}));

// ---------------------------------------------------------------------------
// resolveRef — user/plugin scope (unchanged fs-based behavior; regression
// guard for the branch this feature didn't touch)
// ---------------------------------------------------------------------------

test("resolveRef: user ref resolves ok when file still exists with the same name", withIsolation((th) => {
  const userAgentsDir = path.join(th.home, ".claude", "agents");
  const file = writeAgentFile(userAgentsDir, "bar", { name: "bar" });
  const ref = { name: "bar", scopeKind: "user", file, description: "test agent" };

  const result = resolveRef(ref, []);

  assert.equal(result.status, "ok");
}));

test("resolveRef: user ref is missing when neither the file nor a same-name/scope index entry exists", withIsolation(() => {
  const ref = {
    name: "gone",
    scopeKind: "user",
    file: "/nonexistent/path/gone.md",
    description: "test agent",
  };

  const result = resolveRef(ref, []);

  assert.equal(result.status, "missing");
}));

test("resolveRef: user ref is moved when the original file is gone but a same-name/scope entry exists in the index", withIsolation(() => {
  const oldFile = "/nonexistent/path/moved.md";
  const ref = { name: "moved", scopeKind: "user", file: oldFile, description: "test agent" };
  const newFile = "/some/other/path/moved.md";
  const searchIndex = [{ name: "moved", scopeKind: "user", file: newFile, description: "new loc" }];

  const result = resolveRef(ref, searchIndex);

  assert.equal(result.status, "moved");
  assert.equal(result.agent.file, newFile);
}));

// ---------------------------------------------------------------------------
// buildRosterBlock
// ---------------------------------------------------------------------------

test("buildRosterBlock: omits an inaccessible member and reports a distinct warning", () => {
  const team = { id: "t1", name: "Test Team", orchestrator: null, members: [] };
  const resolvedMembers = [
    {
      ref: { name: "ghost", scopeKind: "project", file: "/x/ghost.md", description: "" },
      status: "inaccessible",
      agent: { name: "ghost", scopeKind: "project", file: "/x/ghost.md", description: "" },
    },
  ];

  const { block, warnings } = buildRosterBlock(team, resolvedMembers);

  assert.ok(!block.includes("ghost"), "inaccessible member must not appear in the written roster");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ghost/);
  assert.match(warnings[0], /not accessible|isn't accessible/);
  assert.doesNotMatch(warnings[0], /is missing/, "must not conflate inaccessible with missing");
});

test("buildRosterBlock: includes an accessible (ok) member's delegate line", () => {
  const team = { id: "t1", name: "Test Team", orchestrator: null, members: [] };
  const resolvedMembers = [
    {
      ref: { name: "helper", scopeKind: "project", file: "/x/helper.md", description: "Helps with X. More detail." },
      status: "ok",
      agent: { name: "helper", scopeKind: "project", file: "/x/helper.md", description: "Helps with X. More detail." },
    },
  ];

  const { block, warnings } = buildRosterBlock(team, resolvedMembers);

  assert.match(block, /\*\*helper\*\*/);
  assert.equal(warnings.length, 0);
});

// ---------------------------------------------------------------------------
// regenerateOrchestratorPrompt — the actual write path; must not touch the
// orchestrator's file when it's inaccessible, and must write the member
// roster when accessible.
// ---------------------------------------------------------------------------

test("regenerateOrchestratorPrompt: inaccessible orchestrator is not written to, byte-for-byte", withIsolation(() => {
  const orchRoot = mkTempDir("aw-orch-");
  const { file } = makeProjectWithAgent(orchRoot, "lead", { name: "lead" });
  const before = fs.readFileSync(file, "utf8");
  const ref = { name: "lead", scopeKind: "project", file, description: "lead agent" };
  const team = { id: "t1", name: "T1", orchestrator: ref, members: [] };

  // Session's cwd/bookmarks don't include orchRoot.
  const unrelatedCwd = mkTempDir("aw-unrelated-");
  const cfg = { bookmarks: [], trackedPluginAgents: [] };
  const idx = buildSearchIndex(unrelatedCwd, path.join(unrelatedCwd, ".claude", "agents"), cfg);

  const note = regenerateOrchestratorPrompt(team, idx);

  const after = fs.readFileSync(file, "utf8");
  assert.equal(after, before, "orchestrator file must be byte-identical — no write occurred");
  assert.match(note, /not accessible|isn't accessible/);
  assert.match(note, /roster not written/);
}));

test("regenerateOrchestratorPrompt: accessible orchestrator gets the roster block, including an accessible member's line", withIsolation(() => {
  const orchRoot = mkTempDir("aw-orch-");
  const { file: orchFile, agentsDir: orchAgentsDir } = makeProjectWithAgent(orchRoot, "lead", { name: "lead" });
  const memberRoot = mkTempDir("aw-member-");
  const { file: memberFile } = makeProjectWithAgent(memberRoot, "helper", {
    name: "helper",
    description: "Helps with things.",
  });

  const orchRef = { name: "lead", scopeKind: "project", file: orchFile, description: "" };
  const memberRef = { name: "helper", scopeKind: "project", file: memberFile, description: "" };
  const team = { id: "t2", name: "T2", orchestrator: orchRef, members: [memberRef] };

  // Both roots bookmarked from cwd=orchRoot's own session.
  const cfg = { bookmarks: [memberRoot], trackedPluginAgents: [] };
  const idx = buildSearchIndex(orchRoot, orchAgentsDir, cfg);

  const note = regenerateOrchestratorPrompt(team, idx);

  const written = fs.readFileSync(orchFile, "utf8");
  assert.match(written, /agent-wizard:team-roster id=t2 START/);
  assert.match(written, /\*\*helper\*\*/);
  assert.match(written, /Helps with things\./);
  assert.doesNotMatch(note, /not written/);
}));

// ---------------------------------------------------------------------------
// stripOrchestratorPromptBlock
// ---------------------------------------------------------------------------

test("stripOrchestratorPromptBlock: does not write when the ref is inaccessible", withIsolation(() => {
  const orchRoot = mkTempDir("aw-orch-");
  const { file } = makeProjectWithAgent(orchRoot, "lead", { name: "lead" });
  fs.appendFileSync(
    file,
    "\n<!-- agent-wizard:team-roster id=t3 START -->\nstuff\n<!-- agent-wizard:team-roster id=t3 END -->\n",
  );
  const before = fs.readFileSync(file, "utf8");
  const ref = { name: "lead", scopeKind: "project", file, description: "" };

  const unrelatedCwd = mkTempDir("aw-unrelated-");
  const cfg = { bookmarks: [], trackedPluginAgents: [] };
  const idx = buildSearchIndex(unrelatedCwd, path.join(unrelatedCwd, ".claude", "agents"), cfg);

  stripOrchestratorPromptBlock(ref, "t3", idx);

  const after = fs.readFileSync(file, "utf8");
  assert.equal(after, before, "file must be untouched when the ref is inaccessible");
}));

// ---------------------------------------------------------------------------
// buildAssignablePool — the actual pool fed to the interactive picker
// ---------------------------------------------------------------------------

test("buildAssignablePool: includes user and project agents, excludes plugin agents", withIsolation((th) => {
  const cwd = mkTempDir("aw-cwd-");
  const { agentsDir } = makeProjectWithAgent(cwd, "proj-agent");
  writeAgentFile(path.join(th.home, ".claude", "agents"), "user-agent");
  // A plugin agent, discovered the same way scan.js does (marketplaces root).
  const pluginDir = path.join(th.home, ".claude", "plugins", "marketplaces", "some-plugin", "agents");
  writeAgentFile(pluginDir, "plugin-agent");

  const cfg = { bookmarks: [], trackedPluginAgents: [] };
  const pool = buildAssignablePool(cwd, agentsDir, cfg);
  const names = pool.map((a) => a.name).sort();

  assert.deepEqual(names, ["proj-agent", "user-agent"]);
  assert.ok(!pool.some((a) => a.scopeKind === "plugin"), "plugin-scope agents must be excluded from the pool");
}));

test("buildAssignablePool: excludes agents whose file is in excludeFiles", withIsolation((th) => {
  const cwd = mkTempDir("aw-cwd-");
  const { agentsDir, file } = makeProjectWithAgent(cwd, "proj-agent");
  const cfg = { bookmarks: [], trackedPluginAgents: [] };

  const poolWithout = buildAssignablePool(cwd, agentsDir, cfg, [file]);

  assert.equal(poolWithout.some((a) => a.file === file), false);
}));

test("buildAssignablePool: excludes a project agent whose root isn't cwd or bookmarked", withIsolation(() => {
  const cwd = mkTempDir("aw-cwd-");
  const cwdAgentsDir = path.join(cwd, ".claude", "agents");
  const unrelatedRoot = mkTempDir("aw-unrelated-");
  makeProjectWithAgent(unrelatedRoot, "ghost");
  const cfg = { bookmarks: [], trackedPluginAgents: [] };

  const pool = buildAssignablePool(cwd, cwdAgentsDir, cfg);

  assert.equal(pool.some((a) => a.name === "ghost"), false);
}));
