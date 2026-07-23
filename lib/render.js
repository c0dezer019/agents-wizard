"use strict";

const fs = require("fs");
const path = require("path");

const {
  reverse,
  bold,
  dim,
  clearScreen,
  frameHome,
  finalizeFrame,
  buildLabeledBorder,
  BOX,
} = require("./theme");
const {
  LOGO,
  computeLogoGutter,
  renderInlineLogoEscape,
  renderSpellEscape,
} = require("./image");
const { updateNoticeEscape } = require("./update-notice");
const {
  TABS,
  MIN_DESC_WIDTH,
  MAX_NAME_WIDTH,
  MAX_SOURCE_WIDTH,
} = require("./constants");
const { truncate } = require("./util");
const { resolveBookmarkEntries } = require("./scan");
const { isRecommended } = require("./detect");

// ---------------------------------------------------------------------------
// List / search / menu / viewer screens
// ---------------------------------------------------------------------------

function getRecentReleaseNotes(repoDir, n) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(repoDir, "RELEASE_NOTES.md"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .slice(0, n)
    .map((line) => line.slice(2).trim());
}

function renderHeaderBox(
  title,
  contentLines,
  termWidth,
  bottomLabel,
  logoGutter,
) {
  const width = Math.max(24, termWidth);
  const inner = width - 4;
  const top = buildLabeledBorder(
    BOX.tl,
    BOX.tr,
    title,
    width,
    logoGutter ? logoGutter + 1 : 0,
  );
  const bottom = buildLabeledBorder(BOX.bl, BOX.br, bottomLabel, width);
  const gutter = logoGutter || 0;
  const textInner = Math.max(0, inner - gutter - (gutter ? 2 : 0));
  const mid = contentLines.map((l) => {
    const divider = gutter ? " ".repeat(gutter) + dim("│ ") : "";
    return (
      dim("│ ") + divider + truncate(l, textInner).padEnd(textInner) + dim(" │")
    );
  });
  return [top, ...mid, bottom];
}

function computeColumnWidths(rows, tabKey, termWidth) {
  const realRows = rows.filter((r) => !r.virtual);
  const nameWidth = Math.min(
    MAX_NAME_WIDTH,
    Math.max(4, ...realRows.map((r) => r.name.length)),
  );

  if (tabKey !== "plugin") {
    const fixed = 2 /* indent */ + nameWidth + 2 /* gap */ + 2; /* '— ' */
    return {
      nameWidth,
      descWidth: Math.max(MIN_DESC_WIDTH, termWidth - fixed),
    };
  }

  const sourceWidth = Math.min(
    MAX_SOURCE_WIDTH,
    Math.max(4, ...realRows.map((r) => (r.source || "").length)),
  );
  const fixed =
    2 /* indent */ +
    2 /* tracked marker */ +
    nameWidth +
    1 /* gap */ +
    sourceWidth +
    1 /* gap */ +
    2; /* '— ' */
  return {
    nameWidth,
    sourceWidth,
    descWidth: Math.max(MIN_DESC_WIDTH, termWidth - fixed),
  };
}

function listViewHeight(headerLineCount) {
  const termRows = process.stdout.rows || 24;
  const chrome = 2 + headerLineCount + 1 + 1 + 1 + 2 + 2;
  return Math.max(3, termRows - chrome);
}

// Teams has no `agents` array (it's a list of teams, not agents) — this is
// the single place that knows how to count either shape for the tab bar.
function tabCount(data, tabKey) {
  return tabKey === "teams" ? data.teams.teams.length : data[tabKey].agents.length;
}

function rowsFor(data, tabKey, projectMode, cfg) {
  if (tabKey === "plugin") return data.plugin.agents.slice();
  if (tabKey === "sessions") return data.sessions.agents.slice();
  if (tabKey === "teams") {
    const rows = data.teams.teams.map((t) => ({
      virtual: true,
      kind: "team",
      teamId: t.id,
      label: `${t.name}   ${dim(
        `(orchestrator: ${t.orchestrator ? t.orchestrator.name : "—"}, ${t.members.length} member${
          t.members.length === 1 ? "" : "s"
        })`,
      )}`,
    }));
    rows.push({ virtual: true, kind: "new-team", label: "+ New team" });
    return rows;
  }
  if (tabKey === "project" && projectMode === "bookmarks") {
    const rows = resolveBookmarkEntries(cfg.bookmarks).map(
      ({ root, pattern }) => ({
        virtual: true,
        kind: "bookmark",
        label: pattern ? `${root}  (from ${pattern})` : root,
        root,
        pattern,
      }),
    );
    rows.push({
      virtual: true,
      kind: "add-bookmark",
      label: "+ Add project folder…",
    });
    return rows;
  }
  const rows = [{ virtual: true, kind: "new", label: "+ New agent" }];
  if (tabKey === "user") {
    // Agents that lead a team (data.teams.teams[].orchestrator) get their
    // own section at the top, ahead of the stack-based split below, so
    // they're one glance away instead of buried in the alphabetical list.
    // An agent is excluded from the stack split below once it's shown here
    // — it should appear once, not twice.
    const leadTeams = new Map();
    for (const t of data.teams.teams) {
      if (!t.orchestrator) continue;
      const names = leadTeams.get(t.orchestrator.file) || [];
      names.push(t.name);
      leadTeams.set(t.orchestrator.file, names);
    }
    const leads = [];
    const rest = [];
    for (const agent of data.user.agents) {
      const teamNames = leadTeams.get(agent.file);
      (teamNames ? leads : rest).push(
        teamNames ? { ...agent, leadOf: teamNames } : agent,
      );
    }

    if (leads.length === 0) {
      // No team leads to show at all — original stack-split behavior,
      // untouched: only sectioned when both buckets are non-empty,
      // otherwise a single flat list.
      if (data.stackTags && data.stackTags.size > 0) {
        const recommended = [];
        const others = [];
        for (const agent of data.user.agents) {
          (isRecommended(agent, data.stackTags) ? recommended : others).push(
            agent,
          );
        }
        if (recommended.length > 0 && others.length > 0) {
          rows.push({
            virtual: true,
            kind: "section",
            label: "recommended agents:",
          });
          rows.push(...recommended);
          rows.push({ virtual: true, kind: "section", label: "others:" });
          rows.push(...others);
          return rows;
        }
      }
      rows.push(...data.user.agents);
      return rows;
    }

    // At least one team lead exists. Once a "team leads:" header is shown,
    // every remaining agent needs its own header too — otherwise they'd
    // render directly underneath with nothing marking the boundary, and
    // read as if they belonged to the team-leads section.
    rows.push({ virtual: true, kind: "section", label: "team leads:" });
    rows.push(...leads);

    if (data.stackTags && data.stackTags.size > 0) {
      const recommended = [];
      const others = [];
      for (const agent of rest) {
        (isRecommended(agent, data.stackTags) ? recommended : others).push(
          agent,
        );
      }
      if (recommended.length > 0) {
        rows.push({
          virtual: true,
          kind: "section",
          label: "recommended agents:",
        });
        rows.push(...recommended);
      }
      if (others.length > 0) {
        rows.push({ virtual: true, kind: "section", label: "others:" });
        rows.push(...others);
      }
      return rows;
    }
    if (rest.length > 0) {
      rows.push({ virtual: true, kind: "section", label: "others:" });
      rows.push(...rest);
    }
    return rows;
  }
  rows.push(...data[tabKey].agents);
  return rows;
}

function stripNoteDate(note) {
  return note.replace(/^\d{4}-\d{2}-\d{2}:\s*/, "");
}

function headerContentLines(data, recentNotes) {
  const lines = [`user: ${data.user.dir}`, "recent changes:"];
  if (recentNotes.length) {
    for (const note of recentNotes) lines.push(`  • ${stripNoteDate(note)}`);
  } else {
    lines.push("  (no RELEASE_NOTES.md found in this checkout)");
  }
  return lines;
}

function renderList(
  data,
  tabIndex,
  selIndex,
  scrollOffset,
  viewHeight,
  status,
  projectMode,
  cfg,
  recentNotes,
  imageLogo,
  version,
) {
  const tabKey = TABS[tabIndex];
  const rows = rowsFor(data, tabKey, projectMode, cfg);
  let out = frameHome();
  const projectTag =
    projectMode === "bookmark-project" ? "  (bookmark project)" : "";
  const headerWidth = process.stdout.columns || 80;
  const contentLines = headerContentLines(data, recentNotes);
  const gutter = imageLogo
    ? computeLogoGutter(contentLines.length, headerWidth)
    : 0;
  const versionSuffix = version ? ` v${version}` : "";
  const headerLines = renderHeaderBox(
    `${LOGO} Agent Wizard${versionSuffix}`,
    contentLines,
    headerWidth,
    `cwd: ${data.project.dir}${projectTag}`,
    gutter,
  );
  if (gutter)
    out += renderInlineLogoEscape(
      imageLogo.protocol,
      imageLogo.base64,
      gutter,
      contentLines.length,
    );
  out += headerLines.join("\n") + "\n\n";

  out +=
    TABS.map((t, i) => {
      const label = ` ${t[0].toUpperCase() + t.slice(1)} (${tabCount(data, t)}) `;
      return i === tabIndex ? reverse(label) : dim(label);
    }).join("  ") + "\n\n";

  if (rows.length === 0) {
    out += dim("  (no agents found in this scope)") + "\n";
  } else {
    const termWidth = process.stdout.columns || 80;
    const cols = computeColumnWidths(rows, tabKey, termWidth);
    const visible = rows.slice(scrollOffset, scrollOffset + viewHeight);
    visible.forEach((row, i) => {
      const absoluteIndex = scrollOffset + i;
      if (row.kind === "section") {
        out += dim(bold(row.label)) + "\n";
        return;
      }
      const label = row.virtual
        ? row.label
        : tabKey === "plugin"
          ? `${cfg.trackedPluginAgents.includes(row.file) ? "★ " : "  "}${truncate(
              row.name,
              cols.nameWidth,
            ).padEnd(
              cols.nameWidth,
            )} ${dim(truncate(row.source || "(unknown)", cols.sourceWidth).padEnd(cols.sourceWidth))} ${dim(
              "— " + truncate(row.description, cols.descWidth),
            )}`
          : `${truncate(row.name, cols.nameWidth).padEnd(cols.nameWidth)}  ${dim(
              "— " +
                truncate(
                  (row.linked ? `[linked: ${row.source}] ` : "") +
                    (row.leadOf ? `[leads: ${row.leadOf.join(", ")}] ` : "") +
                    row.description,
                  cols.descWidth,
                ),
            )}`;
      const line = `  ${label}`;
      out += (absoluteIndex === selIndex ? reverse(line) : line) + "\n";
    });
  }

  const scrollHint =
    rows.length > viewHeight
      ? `   (${Math.min(scrollOffset + 1, rows.length)}-${Math.min(scrollOffset + viewHeight, rows.length)} of ${rows.length})`
      : "";
  let modeHint = "";
  if (tabKey === "project") {
    if (projectMode === "cwd") modeHint = "   b: bookmarks";
    else if (projectMode === "bookmarks")
      modeHint = "   b: cwd   g: jump to project   d: remove bookmark";
    else modeHint = "   Esc: bookmarks   b: cwd";
  }
  const isBookmarksList = tabKey === "project" && projectMode === "bookmarks";
  const isTeams = tabKey === "teams";
  const editHint =
    data[tabKey].writable && !isBookmarksList ? "   e edit   x delete" : "";
  const viewHint =
    isBookmarksList || tabKey === "sessions" || isTeams ? "" : "   v view";
  const copyHint =
    isBookmarksList || tabKey === "sessions" || isTeams
      ? ""
      : "   c copy to project";
  const trackHint = tabKey === "plugin" ? "   u track/untrack → User tab" : "";
  const sessionHint = tabKey === "sessions" ? "   a resume as…" : "";
  const teamsHint = isTeams ? "   x delete team" : "";
  const enterLabel = tabKey === "sessions"
    ? "Enter resume"
    : isTeams
      ? "Enter open/build"
      : "Enter run";
  out +=
    "\n" +
    dim(
      "←/→ tabs   ↑/↓ move   " +
        enterLabel +
        viewHint +
        copyHint +
        editHint +
        trackHint +
        sessionHint +
        teamsHint +
        "   / search   ? help   q quit" +
        modeHint +
        scrollHint,
    ) +
    "\n";
  if (status) out += "\n" + status + "\n";
  out += updateNoticeEscape();
  process.stdout.write(finalizeFrame(out));
}

function renderSearch(
  query,
  results,
  selIndex,
  scrollOffset,
  viewHeight,
  status,
) {
  let out = clearScreen();
  out += bold("Agent Wizard — search") + "\n\n";
  out += `Search: ${query}${reverse(" ")}` + "\n\n";

  if (results.length === 0) {
    out +=
      dim(
        query
          ? "  (no matches)"
          : "  (type to search Project + User + Plugin agents by name/description/project)",
      ) + "\n";
  } else {
    const termWidth = process.stdout.columns || 80;
    const nameWidth = Math.min(
      MAX_NAME_WIDTH,
      Math.max(4, ...results.map((r) => r.name.length)),
    );
    const tagWidth = Math.min(
      MAX_SOURCE_WIDTH,
      Math.max(4, ...results.map((r) => (r.label || "").length + 7)),
    );
    const fixed =
      2 /* indent */ +
      nameWidth +
      1 /* gap */ +
      tagWidth +
      1 /* gap */ +
      2; /* '— ' */
    const descWidth = Math.max(MIN_DESC_WIDTH, termWidth - fixed);
    const visible = results.slice(scrollOffset, scrollOffset + viewHeight);
    visible.forEach((row, i) => {
      const absoluteIndex = scrollOffset + i;
      const scopeTag =
        row.scopeKind === "project"
          ? "proj"
          : row.scopeKind === "user"
            ? "user"
            : "plug";
      const tag = `[${scopeTag}] ${row.label}`;
      const label = `${truncate(row.name, nameWidth).padEnd(nameWidth)} ${dim(
        truncate(tag, tagWidth).padEnd(tagWidth),
      )} ${dim("— " + truncate(row.description, descWidth))}`;
      const line = `  ${label}`;
      out += (absoluteIndex === selIndex ? reverse(line) : line) + "\n";
    });
  }

  const scrollHint =
    results.length > viewHeight
      ? `   (${Math.min(scrollOffset + 1, results.length)}-${Math.min(scrollOffset + viewHeight, results.length)} of ${results.length})`
      : "";
  out +=
    "\n" +
    dim(
      "type to filter   ↑/↓ move   Enter run   Tab actions   Esc back" +
        scrollHint,
    ) +
    "\n";
  if (status) out += "\n" + status + "\n";
  out += updateNoticeEscape();
  process.stdout.write(out);
}

function renderMenu(
  title,
  subtitleLines,
  options,
  idx,
  spellSlot,
  backHint,
  scrollOffset = 0,
  viewHeight = options.length,
) {
  let out = frameHome() + renderSpellEscape(spellSlot);
  out += bold(title) + "\n";
  for (const line of subtitleLines) out += dim(line) + "\n";
  out += "\n";
  const visible = options.slice(scrollOffset, scrollOffset + viewHeight);
  visible.forEach((opt, i) => {
    const absoluteIndex = scrollOffset + i;
    const line = `  ${opt}`;
    out += (absoluteIndex === idx ? reverse(line) : line) + "\n";
  });
  const scrollHint =
    options.length > viewHeight
      ? `   (${Math.min(scrollOffset + 1, options.length)}-${Math.min(scrollOffset + viewHeight, options.length)} of ${options.length})`
      : "";
  const hint = backHint
    ? "↑/↓ move   Enter select   Shift+Tab previous step   Esc cancel"
    : "↑/↓ move   Enter select   Esc back";
  out += "\n" + dim(hint + scrollHint) + "\n";
  process.stdout.write(finalizeFrame(out));
}

function renderViewer(agent, lines, scroll, viewHeight) {
  let out = clearScreen();
  out += bold(agent.file) + "\n\n";
  out += lines.slice(scroll, scroll + viewHeight).join("\n") + "\n";
  const last = Math.min(scroll + viewHeight, lines.length);
  out +=
    "\n" +
    dim(
      `↑/↓ scroll   PgUp/PgDn page (${lines.length ? scroll + 1 : 0}-${last}/${lines.length})   Esc/q back`,
    ) +
    "\n";
  process.stdout.write(out);
}

module.exports = {
  getRecentReleaseNotes,
  renderHeaderBox,
  computeColumnWidths,
  listViewHeight,
  rowsFor,
  stripNoteDate,
  headerContentLines,
  renderList,
  renderSearch,
  renderMenu,
  renderViewer,
};
