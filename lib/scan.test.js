"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { withTempHome, mkTempDir, makeProjectWithAgent, writeAgentFile } = require("./test-helpers");
const { buildSearchIndex } = require("./scan");

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

test("buildSearchIndex: includes project agents from cwd", withIsolation(() => {
  const cwd = mkTempDir("aw-cwd-");
  const { agentsDir } = makeProjectWithAgent(cwd, "foo");
  const cfg = { bookmarks: [], trackedPluginAgents: [] };

  const idx = buildSearchIndex(cwd, agentsDir, cfg);
  const projectEntries = idx.filter((e) => e.scopeKind === "project");

  assert.equal(projectEntries.length, 1);
  assert.equal(projectEntries[0].name, "foo");
  assert.equal(projectEntries[0].root, cwd);
  assert.equal(projectEntries[0].file, path.join(agentsDir, "foo.md"));
}));

test("buildSearchIndex: includes project agents from a bookmarked root, not the cwd", withIsolation(() => {
  const cwd = mkTempDir("aw-cwd-");
  const cwdAgentsDir = path.join(cwd, ".claude", "agents"); // no agents here
  const bookmarkedRoot = mkTempDir("aw-bookmark-");
  makeProjectWithAgent(bookmarkedRoot, "bar");
  const cfg = { bookmarks: [bookmarkedRoot], trackedPluginAgents: [] };

  const idx = buildSearchIndex(cwd, cwdAgentsDir, cfg);
  const projectEntries = idx.filter((e) => e.scopeKind === "project");

  assert.equal(projectEntries.length, 1);
  assert.equal(projectEntries[0].name, "bar");
  assert.equal(projectEntries[0].root, bookmarkedRoot);
}));

test("buildSearchIndex: excludes a project agent whose root is neither cwd nor bookmarked", withIsolation(() => {
  const cwd = mkTempDir("aw-cwd-");
  const cwdAgentsDir = path.join(cwd, ".claude", "agents");
  const unrelatedRoot = mkTempDir("aw-unrelated-");
  makeProjectWithAgent(unrelatedRoot, "ghost");
  const cfg = { bookmarks: [], trackedPluginAgents: [] }; // unrelatedRoot not bookmarked

  const idx = buildSearchIndex(cwd, cwdAgentsDir, cfg);
  const names = idx.filter((e) => e.scopeKind === "project").map((e) => e.name);

  assert.equal(names.includes("ghost"), false);
}));

test("buildSearchIndex: does not double-count when a bookmark resolves to the same root as cwd", withIsolation(() => {
  const cwd = mkTempDir("aw-cwd-");
  const { agentsDir } = makeProjectWithAgent(cwd, "dupe");
  const cfg = { bookmarks: [cwd], trackedPluginAgents: [] };

  const idx = buildSearchIndex(cwd, agentsDir, cfg);
  const dupeEntries = idx.filter((e) => e.scopeKind === "project" && e.name === "dupe");

  assert.equal(dupeEntries.length, 1);
}));

test("buildSearchIndex: user-scope agents come from the (isolated) home dir, not project dirs", withIsolation((th) => {
  const cwd = mkTempDir("aw-cwd-");
  const cwdAgentsDir = path.join(cwd, ".claude", "agents");
  const userAgentsDir = path.join(th.home, ".claude", "agents");
  writeAgentFile(userAgentsDir, "user-agent");
  const cfg = { bookmarks: [], trackedPluginAgents: [] };

  const idx = buildSearchIndex(cwd, cwdAgentsDir, cfg);
  const userEntries = idx.filter((e) => e.scopeKind === "user");

  assert.equal(userEntries.length, 1);
  assert.equal(userEntries[0].name, "user-agent");
}));
