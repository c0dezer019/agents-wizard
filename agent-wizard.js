#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const { TABS, BUILTIN_NAMES } = require("./lib/constants");
const { computeViewport, truncate, expandHome } = require("./lib/util");
const { configFile, loadConfig, saveConfig } = require("./lib/config");
const {
  parseFrontmatter,
  loadAgentFile,
  findPluginAgentDirs,
  dedupeAgents,
  scanAll,
  buildSearchIndex,
  filterSearchIndex,
  excludeBookmarkMatch,
} = require("./lib/scan");
const { clearScreen } = require("./lib/theme");
const {
  setRaw,
  enterAltScreen,
  exitAltScreen,
  isInAltScreen,
  waitForKey,
  triggerRepaint,
  resumeKeyCapture,
} = require("./lib/keys");
const { checkForUpdate } = require("./lib/update-notice");
const { computeVersion } = require("./lib/version");
const {
  detectImageProtocol,
  loadLogoBase64,
  loadSpellBase64,
} = require("./lib/image");
const {
  computeColumnWidths,
  listViewHeight,
  rowsFor,
  headerContentLines,
  renderList,
  getRecentReleaseNotes,
} = require("./lib/render");
const { showHelp } = require("./lib/help");
const {
  runAgentSession,
  editAgent,
  deleteAgent,
  untrackPluginAgent,
  toggleTrackedPluginAgent,
  searchFlow,
  addProjectFolder,
  copyAgentFlow,
  viewFile,
  createFlow,
  buildManualTemplate,
  describeClaudeError,
  buildInteractivePrompt,
} = require("./lib/actions");

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function stateKey(tabKey, projectMode) {
  if (tabKey !== "project") return tabKey;
  if (projectMode === "bookmarks") return "projectBookmarks";
  if (projectMode === "bookmark-project") return "projectBookmarkProject";
  return "project";
}

async function listLoop() {
  let cwd = process.cwd();
  const cfg = loadConfig();
  const recentNotes = getRecentReleaseNotes(__dirname, 4);
  const version = computeVersion(__dirname);
  const protocol = detectImageProtocol();
  const logoBase64 = protocol ? loadLogoBase64(__dirname) : null;
  const imageLogo = logoBase64 ? { protocol, base64: logoBase64 } : null;
  const spellBase64 = protocol ? loadSpellBase64(__dirname) : null;
  let cwdAgentsDir = path.join(cwd, ".claude", "agents");
  let selectedBookmarkRoot = null;
  let projectMode = "cwd";
  let tabIndex = 0;
  const selIndex = {
    project: 0,
    user: 0,
    plugin: 0,
    projectBookmarks: 0,
    projectBookmarkProject: 0,
  };
  const scrollOffset = {
    project: 0,
    user: 0,
    plugin: 0,
    projectBookmarks: 0,
    projectBookmarkProject: 0,
  };
  let status = "";

  process.stdout.write(clearScreen());

  function currentProjectAgentsDir() {
    if (projectMode === "bookmark-project" && selectedBookmarkRoot) {
      return path.join(selectedBookmarkRoot, ".claude", "agents");
    }
    return cwdAgentsDir;
  }

  function enterBookmarkProject(root) {
    if (root !== selectedBookmarkRoot) {
      selIndex.projectBookmarkProject = 0;
      scrollOffset.projectBookmarkProject = 0;
    }
    selectedBookmarkRoot = root;
    projectMode = "bookmark-project";
  }

  function jumpToProject(root) {
    try {
      process.chdir(root);
    } catch (err) {
      return `Failed to jump to ${root}: ${err.message}`;
    }
    cwd = process.cwd();
    cwdAgentsDir = path.join(cwd, ".claude", "agents");
    selectedBookmarkRoot = null;
    projectMode = "cwd";
    selIndex.project = 0;
    scrollOffset.project = 0;
    return `Jumped to ${cwd}`;
  }

  for (;;) {
    const tabKey = TABS[tabIndex];
    const sKey = stateKey(tabKey, projectMode);
    const data = scanAll(cwd, currentProjectAgentsDir(), cfg);
    let rows = rowsFor(data, tabKey, projectMode, cfg);
    if (selIndex[sKey] >= rows.length)
      selIndex[sKey] = Math.max(0, rows.length - 1);
    const viewHeight = listViewHeight(
      headerContentLines(data, recentNotes).length,
    );
    scrollOffset[sKey] = computeViewport(
      rows.length,
      selIndex[sKey],
      scrollOffset[sKey],
      viewHeight,
    );

    renderList(
      data,
      tabIndex,
      selIndex[sKey],
      scrollOffset[sKey],
      viewHeight,
      status,
      projectMode,
      cfg,
      recentNotes,
      imageLogo,
      version,
    );
    status = "";

    setRaw(true);
    const key = await waitForKey();

    if ((key.ctrl && key.name === "c") || key.name === "q") return;
    else if (key.name === "left")
      tabIndex = (tabIndex + TABS.length - 1) % TABS.length;
    else if (key.name === "right") tabIndex = (tabIndex + 1) % TABS.length;
    else if (key.name === "up") {
      let next = Math.max(0, selIndex[sKey] - 1);
      while (next > 0 && rows[next] && rows[next].kind === "section")
        next -= 1;
      selIndex[sKey] = next;
    } else if (key.name === "down") {
      let next = Math.min(rows.length - 1, selIndex[sKey] + 1);
      while (next < rows.length - 1 && rows[next] && rows[next].kind === "section")
        next += 1;
      selIndex[sKey] = next;
    }
    else if (
      key.name === "escape" &&
      tabKey === "project" &&
      projectMode === "bookmark-project"
    ) {
      projectMode = "bookmarks";
    } else if (key.name === "b" && tabKey === "project") {
      if (projectMode === "cwd") {
        projectMode = selectedBookmarkRoot ? "bookmark-project" : "bookmarks";
      } else if (projectMode === "bookmarks") {
        selectedBookmarkRoot = null;
        projectMode = "cwd";
      } else {
        projectMode = "cwd";
      }
    } else if (
      key.name === "d" &&
      tabKey === "project" &&
      projectMode === "bookmarks"
    ) {
      const row = rows[selIndex[sKey]];
      if (row && row.kind === "bookmark") {
        if (row.pattern) {
          excludeBookmarkMatch(cfg, row.pattern, row.root);
          status = `Removed ${row.root} from ${row.pattern}`;
        } else {
          cfg.bookmarks = cfg.bookmarks.filter((b) => b !== row.root);
          status = `Removed bookmark: ${row.root}`;
        }
        saveConfig(cfg);
        if (row.root === selectedBookmarkRoot) selectedBookmarkRoot = null;
      }
    } else if (
      key.name === "g" &&
      tabKey === "project" &&
      projectMode === "bookmarks"
    ) {
      const row = rows[selIndex[sKey]];
      if (row && row.kind === "bookmark") status = jumpToProject(row.root);
    } else if (key.name === "return") {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row) {
        if (tabKey === "project" && projectMode === "bookmarks") {
          if (row.kind === "add-bookmark") {
            const picked = await addProjectFolder(cwd, cfg);
            if (picked && !picked.isGlob) enterBookmarkProject(picked.root);
          } else if (row.kind === "bookmark") {
            enterBookmarkProject(row.root);
          }
        } else if (row.kind === "new") {
          status = await createFlow(data, tabKey, imageLogo, spellBase64);
        } else if (!row.virtual) {
          status = runAgentSession(row);
        }
      }
    } else if (key.name === "v") {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) await viewFile(row);
    } else if (key.name === "e" && data[tabKey].writable) {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) status = await editAgent(row);
    } else if (key.name === "x" && data[tabKey].writable) {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) {
        status = row.linked
          ? untrackPluginAgent(cfg, row)
          : await deleteAgent(row);
      }
    } else if (
      key.name === "c" &&
      !(tabKey === "project" && projectMode === "bookmarks")
    ) {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) status = await copyAgentFlow(row, cwd, cfg);
    } else if (key.str === "u" && tabKey === "plugin") {
      rows = rowsFor(data, tabKey, projectMode, cfg);
      const row = rows[selIndex[sKey]];
      if (row && !row.virtual) status = toggleTrackedPluginAgent(cfg, row);
    } else if (key.str === "/") {
      await searchFlow(cwd, cwdAgentsDir, cfg);
    } else if (key.str === "?") {
      await showHelp();
    }
  }
}

function runUpdate() {
  const repoDir = __dirname;
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    console.error(
      `error: ${repoDir} is not a git checkout (no .git found) — can't update.`,
    );
    process.exit(1);
  }
  console.log(`Updating agent-wizard in ${repoDir}...`);
  const res = spawnSync("git", ["-C", repoDir, "pull"], { stdio: "inherit" });
  if (res.error) {
    console.error(`error: failed to run git: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

function checkWindowsTerminalRecommendation() {
  if (process.platform !== "win32") return Promise.resolve();
  if (process.env.AGENT_WIZARD_SKIP_TERM_CHECK) return Promise.resolve();
  const inWindowsTerminal = Boolean(process.env.WT_SESSION);
  const inWezTerm = process.env.TERM_PROGRAM === "WezTerm";
  if (inWindowsTerminal || inWezTerm) return Promise.resolve();

  console.log(
    [
      "",
      "agent-wizard works best in Windows Terminal (recommended) or WezTerm.",
      "You're running in a different console — the TUI will still work, but",
      "rendering may be inconsistent, and neither the logo image nor spell",
      "animation will show (Windows Terminal never renders these either;",
      "WezTerm is the only Windows terminal that supports both).",
      "",
      "  Windows Terminal: https://aka.ms/terminal",
      "  WezTerm:          https://wezterm.org",
      "",
      "Set AGENT_WIZARD_SKIP_TERM_CHECK=1 to silence this in future.",
      "",
      "Press any key to continue anyway...",
    ].join("\n"),
  );
  return new Promise((resolve) => {
    setRaw(true);
    process.stdin.once("data", () => {
      setRaw(false);
      resolve();
    });
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error(
      "agent-wizard needs an interactive terminal (TTY). Run it directly, not piped.",
    );
    process.exit(1);
  }
  await checkWindowsTerminalRecommendation();
  checkForUpdate();
  readline.emitKeypressEvents(process.stdin);
  resumeKeyCapture();
  enterAltScreen();
  process.stdout.on("resize", () => {
    process.stdout.write(clearScreen());
    triggerRepaint();
  });
  try {
    await listLoop();
  } finally {
    process.stdout.removeListener("resize", triggerRepaint);
    exitAltScreen();
    setRaw(false);
  }
  process.exit(0);
}

process.on("exit", () => {
  try {
    setRaw(false);
    // eslint-disable-next-line no-empty
  } catch {}
  if (isInAltScreen()) process.stdout.write("\x1B[?25h\x1B[?1049l");
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
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(computeVersion(__dirname) || "unknown (not a git checkout)");
    process.exit(0);
  } else if (process.argv.includes("--update")) {
    runUpdate();
  } else {
    main().catch((err) => {
      try {
        exitAltScreen();
        setRaw(false);
        // eslint-disable-next-line no-empty
      } catch {}
      console.error(err);
      process.exit(1);
    });
  }
}
