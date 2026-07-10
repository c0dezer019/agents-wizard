"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ---------------------------------------------------------------------------
// Version estimation (symver) — prefers the nearest git tag reachable from
// HEAD; falls back to walking the full commit log when there's no tag yet.
// Either way, a "-dev" suffix is appended when the checkout isn't exactly
// that release (uncommitted changes, or commits since the tag).
// ---------------------------------------------------------------------------

// Record/unit separator control chars — not a null byte, since Node's
// spawnSync rejects null bytes anywhere in argv.
const COMMIT_SEP = "\x1e";
const FIELD_SEP = "\x1f";

function parseConventionalHeader(subject) {
  const m = /^(\w+)(\([^)]*\))?(!)?:\s*/.exec(subject.trim());
  if (!m) return null;
  return { type: m[1].toLowerCase(), breaking: !!m[3] };
}

function getCommits(repoDir) {
  const res = spawnSync(
    "git",
    ["-C", repoDir, "log", "--reverse", `--pretty=format:%s${FIELD_SEP}%b${COMMIT_SEP}`],
    { encoding: "utf8" },
  );
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split(COMMIT_SEP)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject, body = ""] = c.split(FIELD_SEP);
      return { subject: subject || "", body: body || "" };
    });
}

function isWorkingTreeDirty(repoDir) {
  const res = spawnSync("git", ["-C", repoDir, "status", "--porcelain"], {
    encoding: "utf8",
  });
  return res.status === 0 && res.stdout.trim().length > 0;
}

// Nearest tag reachable from HEAD (annotated or lightweight), or null if the
// repo has no tags at all.
function getLatestTag(repoDir) {
  const res = spawnSync(
    "git",
    ["-C", repoDir, "describe", "--tags", "--abbrev=0"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return null;
  const tag = (res.stdout || "").trim();
  return tag || null;
}

function commitsSinceTag(repoDir, tag) {
  const res = spawnSync(
    "git",
    ["-C", repoDir, "rev-list", `${tag}..HEAD`, "--count"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return 0;
  return parseInt((res.stdout || "0").trim(), 10) || 0;
}

// Walks commit history oldest-to-newest and bumps major/minor/patch using
// conventional-commit semantics (feat -> minor, fix/perf -> patch, a "!" or
// "BREAKING CHANGE" -> major once past 0.x, minor while still 0.x). This is
// an *estimate* — there's no package.json or tag to anchor a real release
// version to, so we derive one from the commit history itself.
function computeVersionFromCommits(commits) {
  let major = 0;
  let minor = 0;
  let patch = 0;
  let any = false;

  for (const { subject, body } of commits) {
    const parsed = parseConventionalHeader(subject);
    if (!parsed) continue;
    const breaking = parsed.breaking || /BREAKING CHANGE/.test(body);
    if (breaking) {
      if (major === 0) {
        minor += 1;
        patch = 0;
      } else {
        major += 1;
        minor = 0;
        patch = 0;
      }
      any = true;
    } else if (parsed.type === "feat") {
      minor += 1;
      patch = 0;
      any = true;
    } else if (parsed.type === "fix" || parsed.type === "perf") {
      patch += 1;
      any = true;
    }
    // chore/docs/style/refactor/test/build/ci/etc. don't bump the version
  }

  if (!any && commits.length === 0) return null;
  return `${major}.${minor}.${patch}`;
}

function computeVersion(repoDir) {
  if (!fs.existsSync(path.join(repoDir, ".git"))) return null;
  const dirty = isWorkingTreeDirty(repoDir);

  const tag = getLatestTag(repoDir);
  if (tag) {
    const base = tag.replace(/^v/, "");
    const ahead = commitsSinceTag(repoDir, tag) > 0;
    return dirty || ahead ? `${base}-dev` : base;
  }

  const base = computeVersionFromCommits(getCommits(repoDir));
  if (!base) return null;
  return dirty ? `${base}-dev` : base;
}

module.exports = {
  computeVersion,
  computeVersionFromCommits,
  parseConventionalHeader,
};
