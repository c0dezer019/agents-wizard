"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const { yellow, ESC } = require("./theme");
const { triggerRepaint } = require("./keys");

// ---------------------------------------------------------------------------
// Update notification (bottom-right corner)
// ---------------------------------------------------------------------------

let updateAvailable = false;
const UPDATE_NOTICE_TEXT = "update available, run --update to update";

function currentBranch(repoDir) {
  const res = spawnSync("git", ["-C", repoDir, "symbolic-ref", "--short", "HEAD"], {
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  const branch = res.stdout.trim();
  return branch || null;
}

function latestLocalTag(repoDir) {
  const res = spawnSync(
    "git",
    ["-C", repoDir, "tag", "--list", "--sort=-v:refname"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return null;
  const tags = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return tags[0] || null;
}

function isAncestor(repoDir, ref) {
  const res = spawnSync(
    "git",
    ["-C", repoDir, "merge-base", "--is-ancestor", ref, "HEAD"],
    { stdio: "ignore" },
  );
  return res.status === 0;
}

function checkForUpdate() {
  const repoDir = path.join(__dirname, "..");
  if (!fs.existsSync(path.join(repoDir, ".git"))) return;
  const branch = currentBranch(repoDir);
  if (!branch) return;
  try {
    const proc = spawn(
      "git",
      ["-C", repoDir, "fetch", "--quiet", "--tags", "origin", branch],
      { stdio: "ignore" },
    );
    proc.on("error", () => {});
    proc.on("close", (code) => {
      if (code !== 0) return;
      try {
        const tag = latestLocalTag(repoDir);
        if (tag && !isAncestor(repoDir, tag)) {
          updateAvailable = true;
          triggerRepaint();
        }
        // eslint-disable-next-line no-empty
      } catch {}
    });
    // eslint-disable-next-line no-empty
  } catch {}
}

function updateNoticeEscape() {
  if (!updateAvailable) return "";
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const col = Math.max(1, cols - UPDATE_NOTICE_TEXT.length + 1);
  return `${ESC}${rows};${col}H${yellow(UPDATE_NOTICE_TEXT)}`;
}

module.exports = { checkForUpdate, updateNoticeEscape };
