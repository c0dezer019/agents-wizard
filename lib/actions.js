"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  isDir,
  expandHome,
  wrapText,
  computeViewport,
  isGlobPattern,
  expandGlobDirs,
  truncate,
} = require("./util");
const { saveConfig } = require("./config");
const {
  buildSearchIndex,
  filterSearchIndex,
  resolveBookmarkEntries,
  parseFrontmatter,
} = require("./scan");
const { clearScreen } = require("./theme");
const {
  waitForKey,
  setRaw,
  exitAltScreen,
  enterAltScreen,
  pauseKeyCapture,
  resumeKeyCapture,
  NON_TEXT_KEY_NAMES,
} = require("./keys");
const { pickSpellSlot } = require("./image");
const { renderSearch, renderViewer } = require("./render");
const { askLine, askMultiline, openEditor, pickOption, BACK } = require("./prompts");
const { BUILTIN_NAMES } = require("./constants");
const { detectSessionId } = require("./sessions");
const { upsertSessionRecord } = require("./session-log");
const { rankOrchestratorCandidates, rankSeniorityCandidates } = require("./detect");
const {
  loadTeams,
  saveTeams,
  createTeam,
  deleteTeam,
  renameTeam,
  setOrchestrator,
  addMember,
  removeMember,
  getTeam,
  teamByName,
  makeAgentRef,
} = require("./teams");

const ADD_AGENT_PROMPT_FILE = path.join(__dirname, "..", "add_agent.md");
const ADD_AGENT_INTERACTIVE_PROMPT_FILE = path.join(
  __dirname,
  "..",
  "finish_agent_interactive.md",
);
const PROMOTE_PROMPT_FILE = path.join(__dirname, "..", "promote_to_lead.md");

// ---------------------------------------------------------------------------
// Actions: view, edit, delete, track/copy, search, and agent creation
// ---------------------------------------------------------------------------

async function viewFile(agent) {
  let scroll = 0;
  for (;;) {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    const viewHeight = Math.max(3, rows - 5);
    const lines = wrapText(agent.raw, cols);
    scroll = Math.min(scroll, Math.max(0, lines.length - viewHeight));
    renderViewer(agent, lines, scroll, viewHeight);
    setRaw(true);
    const key = await waitForKey();
    if (key.name === "up") scroll = Math.max(0, scroll - 1);
    else if (key.name === "down")
      scroll = Math.min(Math.max(0, lines.length - viewHeight), scroll + 1);
    else if (key.name === "pageup") scroll = Math.max(0, scroll - viewHeight);
    else if (key.name === "pagedown")
      scroll = Math.min(
        Math.max(0, lines.length - viewHeight),
        scroll + viewHeight,
      );
    else if (key.name === "escape" || key.name === "q" || key.name === "return")
      return;
    else if (key.ctrl && key.name === "c") process.exit(0);
  }
}

// After a spawn returns, look up the session ID Claude Code assigned (the
// newest .jsonl touched in this project's transcript dir since `since`) and
// record it in agent-wizard's own log (lib/session-log.js) — that log, not
// Claude Code's transcript contents, is what backs the Sessions tab.
function logLaunch(cwd, since, agentName) {
  const sessionId = detectSessionId(cwd, since);
  if (sessionId) upsertSessionRecord({ sessionId, cwd, agentName });
}

function runAgentSession(agent, cwd) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  process.stdout.write(
    `\nStarting claude --agent ${agent.name} (exit the session normally to return to the wizard)...\n\n`,
  );

  const since = Date.now();
  const res = spawnSync("claude", ["--agent", agent.name], {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd,
  });
  resumeKeyCapture();
  enterAltScreen();
  if (res.error)
    return `Could not launch "claude --agent ${agent.name}": ${res.error.message}`;
  logLaunch(cwd, since, agent.name);
  return "";
}

// Resumes a past session from agent-wizard's own log (lib/session-log.js).
// Mirrors runAgentSession's foreground-spawn pattern. `agentOverride` has
// three distinct states:
//   undefined -> "same as before": no --agent passed (Claude Code's own docs
//                say the agent a session started with persists across
//                --resume), and the log's agentName is left unchanged.
//   null      -> "no agent" chosen explicitly: still no --agent passed (no
//                documented way to force-clear an agent Claude Code
//                already restored), but the log now records no agent.
//   string    -> override: --agent <name> passed, log records that name.
function resumeSession(session, agentOverride) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  const args = ["--resume", session.sessionId];
  const isOverrideName = typeof agentOverride === "string";
  if (isOverrideName) args.push("--agent", agentOverride);
  const label = isOverrideName
    ? `claude --resume ${session.sessionId} --agent ${agentOverride}`
    : `claude --resume ${session.sessionId}`;
  process.stdout.write(`\nResuming (${label})...\n`);
  if (!isOverrideName) {
    process.stdout.write(
      "(No --agent passed — Claude Code restores whichever agent, if any, this session last used.)\n",
    );
  }
  process.stdout.write(
    "(exit the session normally to return to the wizard)\n\n",
  );

  const since = Date.now();
  const res = spawnSync("claude", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: session.cwd,
  });
  resumeKeyCapture();
  enterAltScreen();
  if (res.error)
    return `Could not resume session ${session.sessionId}: ${res.error.message}`;
  const loggedAgentName =
    agentOverride === undefined ? session.agentName : agentOverride;
  logLaunch(session.cwd, since, loggedAgentName);
  return "";
}

// Lets the user override which agent to resume a session under, instead of
// the default (same agent it last used). Pulls the combined agent list from
// whatever's already been scanned this tick (project + user only — plugin
// agents aren't directly runnable/relevant here).
async function pickAgentAndResume(session, data) {
  const seen = new Set();
  const names = [];
  for (const scope of [data.project, data.user]) {
    for (const agent of scope.agents) {
      if (!seen.has(agent.name)) {
        seen.add(agent.name);
        names.push(agent.name);
      }
    }
  }
  const SAME_AS_BEFORE = "Same as before (no --agent override)";
  const NO_AGENT = "(no agent — best effort, see below)";
  const options = [SAME_AS_BEFORE, NO_AGENT, ...names.sort()];
  const choice = await pickOption(
    `Resume ${session.sessionId.slice(0, 8)}… as which agent?`,
    [`Previously: ${session.agentName || "no agent"}`],
    options,
  );
  if (choice === null) return "Resume cancelled.";
  const agentOverride =
    choice === SAME_AS_BEFORE ? undefined : choice === NO_AGENT ? null : choice;
  return resumeSession(session, agentOverride);
}

async function editAgent(agent) {
  const { editor, res } = openEditor(agent.file);
  if (res.error)
    return `Could not launch editor "${editor}": ${res.error.message}`;
  return `Edited ${path.basename(agent.file)} with ${editor}.`;
}

async function deleteAgent(agent) {
  const typed = await askLine(
    `Type "${agent.name}" to confirm delete (anything else cancels): `,
  );
  if (typed !== agent.name) return "Delete cancelled.";
  fs.unlinkSync(agent.file);
  return `Deleted ${path.basename(agent.file)}.`;
}

function untrackPluginAgent(cfg, agent) {
  cfg.trackedPluginAgents = cfg.trackedPluginAgents.filter(
    (fp) => fp !== agent.file,
  );
  saveConfig(cfg);
  return `Untracked ${agent.name} from User tab (plugin file itself untouched).`;
}

function trackPluginAgent(cfg, agent) {
  if (!cfg.trackedPluginAgents.includes(agent.file))
    cfg.trackedPluginAgents.push(agent.file);
  saveConfig(cfg);
  return `Tracked ${agent.name} into User tab — editing it there edits this plugin file directly (only do this for a plugin you own/are developing).`;
}

function toggleTrackedPluginAgent(cfg, agent) {
  return cfg.trackedPluginAgents.includes(agent.file)
    ? untrackPluginAgent(cfg, agent)
    : trackPluginAgent(cfg, agent);
}

async function searchFlow(cwd, cwdAgentsDir, cfg) {
  let query = "";
  let selIndex = 0;
  let scrollOffset = 0;
  let status = "";
  for (;;) {
    const results = filterSearchIndex(
      buildSearchIndex(cwd, cwdAgentsDir, cfg),
      query,
    );
    if (selIndex >= results.length) selIndex = Math.max(0, results.length - 1);
    const termRows = process.stdout.rows || 24;
    const viewHeight = Math.max(3, termRows - (status ? 10 : 8));
    scrollOffset = computeViewport(
      results.length,
      selIndex,
      scrollOffset,
      viewHeight,
    );
    renderSearch(query, results, selIndex, scrollOffset, viewHeight, status);
    status = "";

    setRaw(true);
    const key = await waitForKey();
    const row = results[selIndex];
    if (key.ctrl && key.name === "c") process.exit(0);
    else if (key.name === "escape") return;
    else if (key.name === "up") selIndex = Math.max(0, selIndex - 1);
    else if (key.name === "down")
      selIndex = Math.min(results.length - 1, selIndex + 1);
    else if (key.name === "return" || key.name === "enter") {
      if (row) status = runAgentSession(row, row.root || cwd);
    } else if (key.name === "tab") {
      if (row) {
        const deleteLabel = row.linked ? "Untrack from User tab" : "Delete";
        const trackLabel = cfg.trackedPluginAgents.includes(row.file)
          ? "Untrack from User tab"
          : "Track into User tab";
        const copyLabel = "Copy to project…";
        const options = row.writable
          ? ["Launch", "View", "Edit", deleteLabel, copyLabel]
          : row.scopeKind === "plugin"
            ? ["Launch", "View", trackLabel, copyLabel]
            : ["Launch", "View", copyLabel];
        const choice = await pickOption(
          row.name,
          [`[${row.scopeKind}] ${row.label}`, row.description],
          options,
        );
        if (choice === "Launch") status = runAgentSession(row, row.root || cwd);
        else if (choice === "View") await viewFile(row);
        else if (choice === "Edit") status = await editAgent(row);
        else if (choice === copyLabel)
          status = await copyAgentFlow(row, cwd, cfg);
        else if (row.writable && choice === deleteLabel) {
          status = row.linked
            ? untrackPluginAgent(cfg, row)
            : await deleteAgent(row);
        } else if (row.scopeKind === "plugin" && choice === trackLabel) {
          status = toggleTrackedPluginAgent(cfg, row);
        }
      }
    } else if (key.name === "backspace") {
      query = query.slice(0, -1);
      selIndex = 0;
    } else if (
      key.str &&
      !key.ctrl &&
      !key.meta &&
      !NON_TEXT_KEY_NAMES.has(key.name) &&
      !key.str.startsWith("\x1B")
    ) {
      query += key.str;
      selIndex = 0;
    }
  }
}

async function addProjectFolder(cwd, cfg) {
  const typed = await askLine(
    "Path to project folder, or glob (~/folder/**, absolute or ~/…, blank = current directory): ",
  );
  const expanded = expandHome(typed);

  if (expanded && isGlobPattern(expanded)) {
    if (!cfg.bookmarks.includes(expanded)) {
      cfg.bookmarks.push(expanded);
      saveConfig(cfg);
    }
    return { root: null, isGlob: true };
  }

  const root = path.resolve(expanded || cwd);
  if (!isDir(root)) {
    const confirm = await askLine(
      `"${root}" doesn't exist. Create it and add anyway? (y/N): `,
    );
    if (confirm.trim().toLowerCase() !== "y") return null;
    fs.mkdirSync(root, { recursive: true });
  }
  if (!cfg.bookmarks.includes(root)) {
    cfg.bookmarks.push(root);
    saveConfig(cfg);
  }
  return { root, isGlob: false };
}

async function pickCopyTarget(cwd, cfg) {
  const entries = resolveBookmarkEntries(cfg.bookmarks);
  const roots = [cwd, ...entries.map((e) => e.root)];
  const options = [
    `${path.basename(cwd)} (cwd)`,
    ...entries.map((e) => (e.pattern ? `${e.root}  (from ${e.pattern})` : e.root)),
    "Type a path…",
  ];
  const choice = await pickOption("Copy to which project?", [], options);
  if (choice === null) return null;
  if (choice === "Type a path…") {
    const picked = await addProjectFolder(cwd, cfg);
    if (!picked) return null;
    if (!picked.isGlob) return picked.root;
    const matched = resolveBookmarkEntries(cfg.bookmarks).filter(
      (e) => e.pattern && !roots.includes(e.root),
    );
    if (matched.length === 0) return null;
    const subChoice = await pickOption(
      "Pattern added — copy to which matched project?",
      [],
      matched.map((e) => e.root),
    );
    return subChoice;
  }
  return roots[options.indexOf(choice)];
}

async function copyAgentFlow(agent, cwd, cfg) {
  const targetRoot = await pickCopyTarget(cwd, cfg);
  if (!targetRoot) return "Copy cancelled.";
  const targetDir = path.join(targetRoot, ".claude", "agents");
  const targetFile = path.join(targetDir, `${agent.name}.md`);
  if (path.resolve(targetFile) === path.resolve(agent.file)) {
    return `"${agent.name}" is already at ${targetFile} — nothing to copy.`;
  }
  if (fs.existsSync(targetFile)) {
    const confirm = await askLine(
      `${targetFile} already exists. Overwrite? (y/N): `,
    );
    if (confirm.trim().toLowerCase() !== "y") return "Copy cancelled.";
  }
  const dirExisted = isDir(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(agent.file, targetFile);
  let note = `Copied ${agent.name} to ${targetFile}.`;
  if (!dirExisted)
    note += " New agents/ directory — restart Claude Code to pick it up.";
  return note;
}

function buildManualTemplate(name, description, guidelines) {
  const guidelinesBlock = guidelines
    ? `\n\n## Guidelines\n\n${guidelines}\n`
    : "";
  return `---
name: ${name}
description: ${description || "TODO: describe when Claude should delegate to this agent"}
# tools: Read, Grep, Glob   # omit this line to inherit all tools
# model: sonnet             # omit this line to inherit the session model
---

TODO: write the system prompt / instructions for this agent here.${guidelinesBlock}
`;
}

function renderStatusScreen(label) {
  process.stdout.write(`${clearScreen()}\n${label}\n`);
}

function runClaudeGenerate(
  promptText,
  { systemPrompt, systemPromptFile, label } = {},
) {
  renderStatusScreen(label || "Calling claude...");
  const args = ["-p", promptText, "--tools", ""];
  if (systemPromptFile) args.push("--system-prompt-file", systemPromptFile);
  if (systemPrompt) args.push("--system-prompt", systemPrompt);

  const res = spawnSync("claude", args, {
    encoding: "utf8",
    timeout: 120000,
    shell: process.platform === "win32",
  });
  return res;
}

function describeClaudeError(res) {
  if (res.error && res.error.code === "ENOENT")
    return "claude CLI not found in PATH";
  if (res.error) return res.error.message;
  if (res.signal === "SIGTERM") return "claude timed out";
  const stderr = (res.stderr || "").trim();
  return stderr
    ? stderr.split("\n").slice(0, 3).join(" ")
    : `claude exited with status ${res.status}`;
}

async function generateDescription(role, seniority, tasks) {
  const prompt = `Role: ${role}\nSeniority: ${seniority}\nGeneral tasks: ${tasks}`;
  const res = runClaudeGenerate(prompt, {
    systemPrompt:
      'You write a single-sentence "description" field for a Claude Code subagent\'s frontmatter. ' +
      "This sentence is the trigger Claude reads to decide when to delegate to the subagent, so phrase it " +
      "as a concrete condition for use. Output ONLY that one sentence — no quotes, no markdown, no preamble.",
    label: "Asking claude to draft a description from your answers...",
  });
  if (res.error || res.status !== 0)
    return { ok: false, error: describeClaudeError(res) };
  const description = (res.stdout || "").trim();
  if (!description)
    return { ok: false, error: "claude returned an empty description" };
  return { ok: true, description };
}

async function generateAgentFile(
  scopeDir,
  name,
  description,
  role,
  seniority,
  tasks,
  guidelines,
) {
  const prompt = [
    `Directory: ${scopeDir}`,
    `Agent name: ${name}`,
    `Description: ${description}`,
    "",
    `Role: ${role}`,
    `Seniority: ${seniority}`,
    `General tasks: ${tasks}`,
    `Guidelines or restrictions: ${guidelines || "(none given)"}`,
  ].join("\n");
  const res = runClaudeGenerate(prompt, {
    systemPromptFile: ADD_AGENT_PROMPT_FILE,
    label: "Asking claude to draft the agent file...",
  });
  if (res.error || res.status !== 0)
    return { ok: false, error: describeClaudeError(res) };
  const content = (res.stdout || "").trim() + "\n";
  if (!content.startsWith("---")) {
    return {
      ok: false,
      error:
        "claude's output didn't look like a valid agent file (missing frontmatter)",
    };
  }
  return { ok: true, content };
}

function runClaudeInteractive(promptText, systemPromptFile) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  process.stdout.write(
    "\nStarting an interactive claude session to finish this agent together " +
      "(exit the session normally, e.g. Ctrl+D, to return to the wizard)...\n\n",
  );

  const res = spawnSync(
    "claude",
    ["--system-prompt-file", systemPromptFile, promptText],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  resumeKeyCapture();
  enterAltScreen();
  return res;
}

function buildInteractivePrompt(
  target,
  name,
  description,
  role,
  seniority,
  tasks,
  guidelines,
) {
  return [
    `Target file path: ${target}`,
    `Agent name: ${name}`,
    `Description: ${description}`,
    "",
    `Role: ${role}`,
    `Seniority: ${seniority}`,
    `General tasks: ${tasks}`,
    `Guidelines or restrictions: ${guidelines || "(none given)"}`,
  ].join("\n");
}

// Re-reads the just-written file's frontmatter after the editor closes —
// $EDITOR was the last thing to touch it, and the user may have changed
// name/description there, so this is the only point the identity is
// authoritative. Returns null (not thrown) if the file is somehow gone.
function reloadCreatedAgent(target, scopeKind) {
  try {
    const raw = fs.readFileSync(target, "utf8");
    const fm = parseFrontmatter(raw);
    return {
      name: fm.name || path.basename(target, ".md"),
      file: target,
      scopeKind,
      description: fm.description || "",
    };
  } catch {
    return null;
  }
}

async function manualCreateFallback(
  scopeDir,
  target,
  name,
  warning,
  imageLogo,
  spellBase64,
  scopeKind,
) {
  const description = await askLine(
    "One-line description (this is the delegation trigger Claude reads): ",
    pickSpellSlot(imageLogo, spellBase64),
  );
  if (description === null) return { note: "Create cancelled.", created: null };
  const dirExisted = isDir(scopeDir);
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(target, buildManualTemplate(name, description), "utf8");
  const { editor, res } = openEditor(target);
  let note = `${warning} Created ${target}.`;
  if (res.error)
    note += ` (Could not launch editor "${editor}": ${res.error.message})`;
  if (!dirExisted)
    note += " New agents/ directory — restart Claude Code to pick it up.";
  return { note, created: reloadCreatedAgent(target, scopeKind) };
}

const CREATE_STEPS = ["name", "role", "seniority", "tasks", "guidelines"];
const CREATE_PROMPTS = {
  name: "New agent name (lowercase-hyphens, e.g. code-reviewer): ",
  role: 'Role — what should this agent be? (e.g. "code reviewer", "database migration specialist"): ',
  seniority: "Seniority / experience level? (e.g. junior, senior, principal): ",
  tasks: "General tasks it will perform (a sentence, list, or a few paragraphs):",
  guidelines:
    "Guidelines or restrictions? (optional — constraints, style, things to avoid):",
};
// tasks/guidelines get the multi-line $EDITOR-backed prompt instead of a
// single-line one — both can run long and benefit from real line editing.
const MULTILINE_STEPS = new Set(["tasks", "guidelines"]);

// Walks the text-input steps starting at `startIndex`, seeded with `seed`
// answers. Esc cancels the whole create flow immediately (returns null),
// from any step. Shift+Tab steps back to re-ask the previous one, prefilled
// with what was typed there before (a no-op on step 0, nothing before it).
async function collectCreateAnswers(spellSlot, seed, startIndex = 0) {
  const answers = { ...seed };
  let i = startIndex;
  while (i < CREATE_STEPS.length) {
    const step = CREATE_STEPS[i];
    const val = MULTILINE_STEPS.has(step)
      ? await askMultiline(CREATE_PROMPTS[step], spellSlot(), answers[step], step)
      : await askLine(CREATE_PROMPTS[step], spellSlot(), answers[step]);
    if (val === null) return null;
    if (val === BACK) {
      if (i > 0) i--;
      continue;
    }
    answers[step] = val;
    i++;
  }
  return answers;
}

// Returns { note, created }. `created` is `{name, file, scopeKind}` on any
// path that actually wrote a file (the normal finish, or the
// manualCreateFallback taken when claude -p is unreachable), and `null` on
// every cancel/validation return — callers that need to assign the new
// agent to a slot (see lib/teams.js flows) rely on that distinction.
async function createFlow(data, tabKey, imageLogo, spellBase64) {
  const scopeKind = tabKey === "project" ? "project" : "user";
  const scopeDir =
    tabKey === "project"
      ? data.project.dir
      : path.join(os.homedir(), ".claude", "agents");
  const spellSlot = () => pickSpellSlot(imageLogo, spellBase64); // fresh random spot per question, held fixed for that question's own redraws

  let answers = {
    name: "",
    role: "",
    seniority: "",
    tasks: "",
    guidelines: "",
  };
  let name, role, seniority, tasks, guidelines, description, target;
  let finishChoice;

  answers = await collectCreateAnswers(spellSlot, answers, 0);
  if (!answers) return { note: "Create cancelled.", created: null }; // Esc: bail out, nothing written

  for (;;) {
    ({ name, role, seniority, tasks, guidelines } = answers);

    if (!name) return { note: "Create cancelled (empty name).", created: null };
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return {
        note: "Create cancelled: name must be lowercase letters/digits/hyphens, starting with a letter.",
        created: null,
      };
    }
    if (BUILTIN_NAMES.has(name)) {
      return {
        note: `Create cancelled: "${name}" is a built-in agent name and can't be shadowed.`,
        created: null,
      };
    }
    target = path.join(scopeDir, `${name}.md`);
    if (fs.existsSync(target)) {
      return {
        note: `Create cancelled: ${target} already exists — use Edit instead.`,
        created: null,
      };
    }

    const descResult = await generateDescription(role, seniority, tasks);
    if (!descResult.ok) {
      return manualCreateFallback(
        scopeDir,
        target,
        name,
        `Couldn't draft a description via claude (${descResult.error}).`,
        imageLogo,
        spellBase64,
        scopeKind,
      );
    }
    description = descResult.description;

    finishChoice = await pickOption(
      "How should claude finish drafting this file?",
      [`name: ${name}`, `description: "${description}"`],
      [
        "Auto-draft with claude -p",
        "Open interactive claude session",
        "Skip — use manual template",
      ],
      spellSlot(),
      true, // enableBack: Shift+Tab returns to the text steps
    );
    if (finishChoice === null) return { note: "Create cancelled.", created: null }; // Esc: cancel outright
    if (finishChoice === BACK) {
      // Shift+Tab on the finish menu: re-enter the text steps starting
      // from the last one (guidelines), prefilled with prior answers.
      answers = await collectCreateAnswers(
        spellSlot,
        answers,
        CREATE_STEPS.length - 1,
      );
      if (!answers) return { note: "Create cancelled.", created: null };
      continue;
    }
    break;
  }

  const dirExisted = isDir(scopeDir);
  fs.mkdirSync(scopeDir, { recursive: true });

  let note;
  if (finishChoice === "Open interactive claude session") {
    const prompt = buildInteractivePrompt(
      target,
      name,
      description,
      role,
      seniority,
      tasks,
      guidelines,
    );
    runClaudeInteractive(prompt, ADD_AGENT_INTERACTIVE_PROMPT_FILE);
    if (fs.existsSync(target)) {
      note = `Created ${target} (finished interactively with claude).`;
    } else {
      fs.writeFileSync(
        target,
        buildManualTemplate(name, description, guidelines),
        "utf8",
      );
      note = `Created ${target} with a manual template — the interactive session ended without writing the file.`;
    }
  } else if (finishChoice === "Auto-draft with claude -p") {
    const fileResult = await generateAgentFile(
      scopeDir,
      name,
      description,
      role,
      seniority,
      tasks,
      guidelines,
    );
    if (fileResult.ok) {
      fs.writeFileSync(target, fileResult.content, "utf8");
      note = `Created ${target} (drafted by claude — description: "${description}").`;
    } else {
      fs.writeFileSync(
        target,
        buildManualTemplate(name, description, guidelines),
        "utf8",
      );
      note = `Created ${target} with a manual template — claude couldn't draft the full file (${fileResult.error}).`;
    }
  } else {
    fs.writeFileSync(
      target,
      buildManualTemplate(name, description, guidelines),
      "utf8",
    );
    note = `Created ${target} with a manual template.`;
  }

  const { editor, res } = openEditor(target);
  if (res.error)
    note += ` (Could not launch editor "${editor}": ${res.error.message})`;
  if (!dirExisted) {
    note += " New agents/ directory — restart Claude Code to pick it up.";
  }
  return { note, created: reloadCreatedAgent(target, scopeKind) };
}

// ---------------------------------------------------------------------------
// Promote an agent to lead: fork a senior/principal IC agent into a lead
// version of itself — copy to a new file, then run an LLM rewrite pass on
// the copy (IC framing -> delegator framing). The original is never opened
// for write. Returns { note, created } — same contract as createFlow.
// ---------------------------------------------------------------------------

async function promoteRewrite(target, originalRaw, newName, guidance) {
  const promptText = [
    `New agent name: ${newName}`,
    "",
    "Original agent file:",
    "```",
    originalRaw,
    "```",
    "",
    `Delegation guidance: ${guidance || "(none given)"}`,
  ].join("\n");
  const res = runClaudeGenerate(promptText, {
    systemPromptFile: PROMOTE_PROMPT_FILE,
    label: "Asking claude to rewrite this agent as a lead...",
  });
  if (res.error || res.status !== 0)
    return { ok: false, error: describeClaudeError(res) };
  const content = (res.stdout || "").trim() + "\n";
  if (!content.startsWith("---")) {
    return {
      ok: false,
      error: "claude's output didn't look like a valid agent file (missing frontmatter)",
    };
  }
  return { ok: true, content };
}

async function promoteAgentToLead(ctx) {
  const { cwd, cwdAgentsDir, cfg, imageLogo, spellBase64 } = ctx;
  const spellSlot = () => pickSpellSlot(imageLogo, spellBase64);
  const scopeKind = "user";
  const scopeDir = path.join(os.homedir(), ".claude", "agents");

  const pool = buildSearchIndex(cwd, cwdAgentsDir, cfg).filter(
    (a) => a.scopeKind === "user",
  );
  const candidates = rankSeniorityCandidates(pool).filter((c) => c.seniorityScore > 0);
  if (candidates.length === 0) {
    await pickOption(
      "No senior/principal agents found to promote.",
      [],
      ["Back — create a new agent instead"],
    );
    return { note: "", created: null };
  }

  const seen = new Map();
  const optionStrings = candidates.map((c) => {
    const oneLineDesc = truncate((c.description || "").replace(/\s+/g, " ").trim(), 80);
    const base = `${c.name}  — ${oneLineDesc}`;
    const dupeCount = seen.get(base) || 0;
    seen.set(base, dupeCount + 1);
    return dupeCount === 0 ? base : `${base}  (#${dupeCount + 1})`;
  });

  const original = await pickOption("Promote which agent to lead?", [], optionStrings, spellSlot());
  if (original === null) return { note: "", created: null };
  const source = candidates[optionStrings.indexOf(original)];
  if (!source) return { note: "", created: null };

  let name = `${source.name}-lead`;
  for (;;) {
    name = await askLine(
      "New lead agent name (lowercase-hyphens): ",
      spellSlot(),
      name,
    );
    if (name === null || name === BACK) return { note: "Promote cancelled.", created: null };
    if (!name) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      const retry = await pickOption(
        "Name must be lowercase letters/digits/hyphens, starting with a letter.",
        [],
        ["Try a different name", "Cancel"],
      );
      if (retry !== "Try a different name") return { note: "Promote cancelled.", created: null };
      continue;
    }
    if (BUILTIN_NAMES.has(name)) {
      const retry = await pickOption(
        `"${name}" is a built-in agent name and can't be shadowed.`,
        [],
        ["Try a different name", "Cancel"],
      );
      if (retry !== "Try a different name") return { note: "Promote cancelled.", created: null };
      continue;
    }
    const target = path.join(scopeDir, `${name}.md`);
    if (fs.existsSync(target)) {
      const retry = await pickOption(
        `${target} already exists.`,
        [],
        ["Try a different name", "Cancel"],
      );
      if (retry !== "Try a different name") return { note: "Promote cancelled.", created: null };
      continue;
    }
    break;
  }
  const target = path.join(scopeDir, `${name}.md`);

  const guidance = await askMultiline(
    "How should this lead delegate? (optional — notes on what to watch for, who to hand work to):",
    spellSlot(),
    "",
    "promote-guidance",
  );
  // Esc or Shift+Tab both just skip guidance — there's no prior step to
  // return to here.
  const guidanceText = guidance === null || guidance === BACK ? "" : guidance;

  const dirExisted = isDir(scopeDir);
  fs.mkdirSync(scopeDir, { recursive: true });
  // Seed the copy with the original's raw content first — guarantees a file
  // exists even if the LLM rewrite step below fails.
  fs.writeFileSync(target, source.raw || "", "utf8");

  const finishChoice = await pickOption(
    "How should claude finish rewriting this lead agent?",
    [`name: ${name}`, `forked from: ${source.name}`],
    [
      "Auto-draft with claude -p",
      "Open interactive claude session",
      "Skip — use the plain copy",
    ],
    spellSlot(),
  );

  let note;
  if (finishChoice === null) {
    note = `Promote cancelled after copying — a plain copy of "${source.name}" was left at ${target}.`;
  } else if (finishChoice === "Open interactive claude session") {
    const prompt = [
      `New agent name: ${name}`,
      `Target file path: ${target}`,
      "",
      "Original agent file:",
      "```",
      source.raw || "",
      "```",
      "",
      `Delegation guidance: ${guidanceText || "(none given)"}`,
    ].join("\n");
    runClaudeInteractive(prompt, PROMOTE_PROMPT_FILE);
    note = `Rewrote ${target} (finished interactively with claude), forked from "${source.name}".`;
  } else if (finishChoice === "Auto-draft with claude -p") {
    const result = await promoteRewrite(target, source.raw || "", name, guidanceText);
    if (result.ok) {
      fs.writeFileSync(target, result.content, "utf8");
      note = `Rewrote ${target} as a lead (drafted by claude), forked from "${source.name}".`;
    } else {
      note = `Kept the plain copy at ${target} — claude couldn't draft the rewrite (${result.error}).`;
    }
  } else {
    note = `Copied "${source.name}" to ${target} — edit it by hand to reshape it into a lead.`;
  }

  if (finishChoice !== null) {
    const { editor, res } = openEditor(target);
    if (res.error)
      note += ` (Could not launch editor "${editor}": ${res.error.message})`;
  }
  if (!dirExisted) {
    note += " New agents/ directory — restart Claude Code to pick it up.";
  }
  return { note, created: reloadCreatedAgent(target, scopeKind) };
}

// ---------------------------------------------------------------------------
// Team-builder: agent-reference resolution + orchestrator prompt generation.
//
// A team's orchestrator/members are stored as AgentRef {name, scopeKind,
// file, description} (lib/teams.js) — resolveRef checks whether that file
// still exists and still parses to the same name, so the roster can warn
// instead of silently going stale when an agent file moves or is renamed.
//
// The generated roster lives in the orchestrator's .md body as a managed
// block delimited by HTML comments keyed to the team id (never the team
// name, which could contain "-->"). Re-running regenerateOrchestratorPrompt
// replaces the block in place — the user's own prose above/below it, and the
// frontmatter, are never touched.
// ---------------------------------------------------------------------------

function resolveRef(ref, searchIndex) {
  // Project-scope agents only ever enter the picker (assignAgentToSlot) when
  // their root is the current cwd or bookmarked (see buildSearchIndex) — a
  // team can be built from one machine/session and opened from another where
  // that root isn't accessible. Unlike user/plugin refs, don't trust a bare
  // fs.existsSync(ref.file): the file may still be sitting on disk yet be
  // outside this session's reach. Require it to still show up in *this*
  // session's search index before treating it as live.
  if (ref.scopeKind === "project") {
    const found = (searchIndex || []).find(
      (e) => e.scopeKind === "project" && e.file === ref.file,
    );
    if (!found) return { status: "inaccessible", agent: { ...ref } };
    const agent = {
      name: found.name,
      scopeKind: "project",
      file: found.file,
      description: found.description,
    };
    return { status: found.name === ref.name ? "ok" : "renamed", agent };
  }

  try {
    if (fs.existsSync(ref.file)) {
      const raw = fs.readFileSync(ref.file, "utf8");
      const fm = parseFrontmatter(raw);
      const liveName = fm.name || path.basename(ref.file, ".md");
      const agent = {
        name: liveName,
        scopeKind: ref.scopeKind,
        file: ref.file,
        description: fm.description || ref.description,
      };
      return { status: liveName === ref.name ? "ok" : "renamed", agent };
    }
  } catch {
    // fall through to the missing/moved handling below
  }
  const moved = (searchIndex || []).find(
    (e) => e.name === ref.name && e.scopeKind === ref.scopeKind,
  );
  if (moved) {
    return {
      status: "moved",
      agent: {
        name: moved.name,
        scopeKind: moved.scopeKind,
        file: moved.file,
        description: moved.description,
      },
    };
  }
  return { status: "missing", agent: { ...ref } };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function managedBlockRegex(teamId) {
  const escId = escapeRegExp(teamId);
  return new RegExp(
    `<!-- agent-wizard:team-roster id=${escId} START -->[\\s\\S]*?<!-- agent-wizard:team-roster id=${escId} END -->\\n?`,
  );
}

// resolvedMembers: [{ ref, status, agent }] — pre-resolved by the caller via
// resolveRef, one entry per team.members ref. Missing/renamed members are
// omitted from the generated roster (the delegation prose would reference a
// name that no longer resolves) and instead reported back as warnings.
function buildRosterBlock(team, resolvedMembers) {
  const live = resolvedMembers.filter(
    (r) => r.status === "ok" || r.status === "moved",
  );
  const omitted = resolvedMembers.filter(
    (r) => r.status !== "ok" && r.status !== "moved",
  );

  const lines = [
    `<!-- agent-wizard:team-roster id=${team.id} START -->`,
    `## Team: ${team.name}`,
    "",
    "You lead these member agents. Delegate by name via the Task tool when a task matches one:",
    "",
  ];
  if (live.length === 0) {
    lines.push("(no members assigned yet)");
  } else {
    for (const r of live) {
      const desc = r.agent.description || "(no description)";
      const hint = (desc.split(/[.!?]/)[0] || desc).trim();
      lines.push(`- **${r.agent.name}** — ${desc} (delegate for: ${hint})`);
    }
  }
  lines.push(`<!-- agent-wizard:team-roster id=${team.id} END -->`);

  const warnings = omitted.map((r) => {
    const reason =
      r.status === "missing"
        ? "is missing"
        : r.status === "inaccessible"
          ? "isn't accessible from this session (project not cwd or bookmarked)"
          : "was renamed";
    return `member "${r.ref.name}" ${reason} — omitted from roster.`;
  });
  return { block: lines.join("\n") + "\n", warnings };
}

function upsertManagedBlock(rawText, teamId, block) {
  const re = managedBlockRegex(teamId);
  if (re.test(rawText)) return rawText.replace(re, block);
  const sep = rawText.endsWith("\n") ? "\n" : "\n\n";
  return rawText + sep + block;
}

function stripManagedBlock(rawText, teamId) {
  const re = managedBlockRegex(teamId);
  // Collapse whatever's left at EOF (including the blank-line separator
  // upsertManagedBlock inserted before the block) down to a single trailing
  // newline, so strip-after-upsert round-trips back to the original text.
  return rawText.replace(re, "").replace(/\n{2,}$/, "\n");
}

// IO wrapper: (re)writes the orchestrator's managed roster block. Returns a
// human-readable status/warning string — never throws; write failures (e.g.
// a read-only plugin file slipping past the scopeKind check) are caught and
// reported instead of crashing the flow that called this.
function regenerateOrchestratorPrompt(team, searchIndex) {
  if (!team.orchestrator) return "No orchestrator assigned — prompt not generated.";
  if (team.orchestrator.scopeKind === "plugin") {
    return `Orchestrator "${team.orchestrator.name}" is a read-only plugin agent — roster not written.`;
  }
  const orchResolved = resolveRef(team.orchestrator, searchIndex);
  if (orchResolved.status === "missing") {
    return `Orchestrator file not found at ${team.orchestrator.file} — roster not written.`;
  }
  if (orchResolved.status === "inaccessible") {
    return `Orchestrator "${team.orchestrator.name}" isn't accessible from this session (project not cwd or bookmarked) — roster not written.`;
  }
  const file = orchResolved.agent.file;
  const resolvedMembers = team.members.map((ref) => ({
    ref,
    ...resolveRef(ref, searchIndex),
  }));
  const { block, warnings } = buildRosterBlock(team, resolvedMembers);
  try {
    const raw = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, upsertManagedBlock(raw, team.id, block), "utf8");
  } catch (err) {
    return `Could not write orchestrator prompt to ${file}: ${err.message}`;
  }
  const renamedWarn =
    orchResolved.status === "renamed"
      ? ` Warning: orchestrator's frontmatter name changed to "${orchResolved.agent.name}" — "claude --agent ${team.orchestrator.name}" may no longer work.`
      : "";
  const memberWarn = warnings.length ? ` ${warnings.join(" ")}` : "";
  return `Updated orchestrator prompt for "${team.name}" in ${file}.${renamedWarn}${memberWarn}`.trim();
}

// Used when reassigning/deleting: removes this team's block from an agent
// file that used to be (or still is) an orchestrator, so a stale roster
// doesn't linger in a file that's no longer leading that team.
function stripOrchestratorPromptBlock(ref, teamId, searchIndex) {
  if (!ref || ref.scopeKind === "plugin") return "";
  const resolved = resolveRef(ref, searchIndex);
  if (resolved.status === "missing" || resolved.status === "inaccessible") return "";
  const file = resolved.agent.file;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const stripped = stripManagedBlock(raw, teamId);
    if (stripped !== raw) fs.writeFileSync(file, stripped, "utf8");
    return "";
  } catch (err) {
    return `Could not remove roster block from ${file}: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Team-builder: build/edit flows (own-loop sub-screens, like searchFlow).
// ---------------------------------------------------------------------------

// Fills one slot (the orchestrator, or a member) by letting the user pick an
// existing agent from any scope, or create a new one on the spot. Returns an
// AgentRef, or null on cancel.
//
// `rankByRole` ranks candidates by lib/detect.js's role-context score (used
// for the orchestrator slot only — members list alphabetically). Since
// pickOption returns the chosen *string* and two candidates can render
// identical labels (same basename in different scopes/bookmark roots),
// option strings are de-duplicated with a "(#n)" suffix and matched back to
// a candidate by array index, never by re-comparing the string.
// User-scope agents (~/.claude/agents + tracked plugin links, which
// buildSearchIndex already reports as scopeKind "user") plus project-scope
// agents from cwd and bookmarked project roots — buildSearchIndex only
// includes a project root's agents if that root is cwd or bookmarked and
// actually has a .claude/agents dir, so that's the gate. Read-only plugin
// agents are excluded — resolveRef/regenerateOrchestratorPrompt can't write
// a roster block into a file the tool doesn't own.
// Pure (besides the fs reads buildSearchIndex itself does) so it's testable
// without going through the interactive assignAgentToSlot picker.
function buildAssignablePool(cwd, cwdAgentsDir, cfg, excludeFiles = []) {
  return buildSearchIndex(cwd, cwdAgentsDir, cfg).filter(
    (a) =>
      (a.scopeKind === "user" || a.scopeKind === "project") &&
      !excludeFiles.includes(a.file),
  );
}

async function assignAgentToSlot(slotLabel, opts) {
  const { rankByRole, excludeFiles = [], warnOnAssign = false, ctx } = opts;
  const { cwd, cwdAgentsDir, cfg } = ctx;

  const pool = buildAssignablePool(cwd, cwdAgentsDir, cfg, excludeFiles);
  const ranked = rankByRole
    ? rankOrchestratorCandidates(pool)
    : pool.slice().sort((a, b) => a.name.localeCompare(b.name));

  // For the orchestrator slot, default to only the agents that actually
  // read as lead/manager-shaped — showing every user agent defeats the
  // point of a recommender. "Show all" is one keystroke away for the case
  // where nothing scores (or the user wants to override the recommendation).
  const recommended = rankByRole ? ranked.filter((c) => c.roleScore > 0) : ranked;
  let showAll = !rankByRole || recommended.length === ranked.length;

  for (;;) {
    const candidates = showAll ? ranked : recommended;
    const seen = new Map();
    const optionStrings = candidates.map((c) => {
      // Descriptions can be multi-paragraph free text — collapse to one
      // line and cap length so a single candidate can't blow out the menu.
      const oneLineDesc = truncate((c.description || "").replace(/\s+/g, " ").trim(), 80);
      const scopeTag = c.scopeKind === "project" ? ` [${c.label}]` : "";
      const base = `${c.name}${scopeTag}  — ${oneLineDesc}`;
      const dupeCount = seen.get(base) || 0;
      seen.set(base, dupeCount + 1);
      return dupeCount === 0 ? base : `${base}  (#${dupeCount + 1})`;
    });

    const CREATE_NEW = "+ Create new agent for this slot…";
    // Orchestrator slot only — promoting doesn't make sense for a member
    // assignment, which never mutates the assigned agent's file.
    const PROMOTE = "★ Promote a senior/principal agent to lead…";
    const SHOW_ALL = `Show all ${ranked.length} agent${ranked.length === 1 ? "" : "s"}…`;
    const options = [
      CREATE_NEW,
      ...(rankByRole ? [PROMOTE] : []),
      ...(!showAll && ranked.length > recommended.length ? [SHOW_ALL] : []),
      ...optionStrings,
    ];
    const choice = await pickOption(
      `Assign ${slotLabel}`,
      candidates.length
        ? []
        : [showAll ? "(no other agents available yet)" : "(no agents read as lead/manager-shaped yet)"],
      options,
    );
    if (choice === null) return null;
    if (choice === CREATE_NEW) return createAgentForSlot(ctx);
    if (choice === PROMOTE) {
      const { created } = await promoteAgentToLead(ctx);
      if (created) return makeAgentRef(created);
      continue; // cancelled / empty pool / promote flow backed out
    }
    if (choice === SHOW_ALL) {
      showAll = true;
      continue;
    }
    const optionOffset = options.length - optionStrings.length;
    const candidate = candidates[options.indexOf(choice) - optionOffset];
    if (!candidate) return null;

    // Assigning an *existing* agent to a file-mutating slot (currently just
    // the orchestrator — see regenerateOrchestratorPrompt) writes into that
    // agent's own .md. Confirm before doing it to someone's file, same as
    // any other destructive-ish action in this tool; declining re-shows the
    // same picker instead of bailing out of the whole assignment.
    if (warnOnAssign) {
      const confirmChoice = await pickOption(
        `Assign "${candidate.name}" as ${slotLabel}?`,
        [
          `This will add/update a managed section in ${candidate.file}`,
          "to note it leads this team's members. Everything else in the",
          "file — its own prompt, frontmatter, hand-written prose — is",
          "left untouched, but the file itself will be modified.",
        ],
        ["Assign and update its file", "Cancel"],
      );
      if (confirmChoice !== "Assign and update its file") continue;
    }
    return makeAgentRef(candidate);
  }
}

async function createAgentForSlot(ctx) {
  const { data, imageLogo, spellBase64 } = ctx;
  // Always User scope — "create new" here is for a fresh agent, not picking
  // an existing project one (that's what the assignable pool in
  // assignAgentToSlot already surfaces for cwd/bookmarked projects).
  const { created } = await createFlow(data, "user", imageLogo, spellBase64);
  return created ? makeAgentRef(created) : null;
}

async function buildTeamFlow(ctx) {
  const { cwd, cwdAgentsDir, cfg, imageLogo, spellBase64 } = ctx;
  const spellSlot = () => pickSpellSlot(imageLogo, spellBase64);

  let name;
  for (;;) {
    name = await askLine("Team name: ", spellSlot());
    if (name === null || name === BACK) return "Create team cancelled.";
    if (!name) continue;
    if (teamByName(loadTeams(), name)) {
      const choice = await pickOption(
        `A team named "${name}" already exists.`,
        [],
        ["Try a different name", "Cancel"],
      );
      if (choice !== "Try a different name") return "Create team cancelled.";
      continue;
    }
    break;
  }

  let orchestrator = await assignAgentToSlot("orchestrator", {
    rankByRole: true,
    excludeFiles: [],
    warnOnAssign: true,
    ctx,
  });
  if (!orchestrator) {
    const choice = await pickOption(
      "No orchestrator assigned.",
      [],
      ["Save team without orchestrator", "Cancel team creation"],
    );
    if (choice !== "Save team without orchestrator") return "Create team cancelled.";
  }

  const members = [];
  for (;;) {
    const excludeFiles = [
      ...(orchestrator ? [orchestrator.file] : []),
      ...members.map((m) => m.file),
    ];
    const memberLines = members.length
      ? members.map((m) => `  - ${m.name} [${m.scopeKind}]`)
      : ["  (none yet)"];
    const DONE = "Done — save team";
    const choice = await pickOption("Roster:", memberLines, ["+ Add member", DONE]);
    if (choice === null || choice === DONE) break;
    const ref = await assignAgentToSlot("member", { rankByRole: false, excludeFiles, ctx });
    if (!ref) continue;
    if (members.some((m) => m.name === ref.name)) {
      const dupChoice = await pickOption(
        `A member named "${ref.name}" is already on this roster — delegation by name would be ambiguous.`,
        [],
        ["Add anyway", "Skip"],
      );
      if (dupChoice !== "Add anyway") continue;
    }
    members.push(ref);
  }

  let teams = createTeam(loadTeams(), name);
  const team = teamByName(teams, name);
  teams = setOrchestrator(teams, team.id, orchestrator);
  for (const m of members) teams = addMember(teams, team.id, m);
  saveTeams(teams);

  const searchIndex = buildSearchIndex(cwd, cwdAgentsDir, cfg);
  const promptNote = regenerateOrchestratorPrompt(getTeam(teams, team.id), searchIndex);
  return `Created team "${name}" with ${members.length} member(s). ${promptNote}`.trim();
}

async function teamDetailFlow(teamId, ctx) {
  const { cwd, cwdAgentsDir, cfg } = ctx;
  let note = "";
  for (;;) {
    let teams = loadTeams();
    const team = getTeam(teams, teamId);
    if (!team) return "Team no longer exists.";
    const searchIndex = buildSearchIndex(cwd, cwdAgentsDir, cfg);
    const orchResolved = team.orchestrator ? resolveRef(team.orchestrator, searchIndex) : null;
    const memberResolved = team.members.map((ref) => ({ ref, ...resolveRef(ref, searchIndex) }));

    const orchLine = team.orchestrator
      ? `Orchestrator: ${team.orchestrator.name} [${team.orchestrator.scopeKind}]` +
        (orchResolved.status !== "ok" ? ` (${orchResolved.status})` : "")
      : "Orchestrator: (unassigned)";
    const memberLines = memberResolved.length
      ? memberResolved.map(
          (m) =>
            `  - ${m.ref.name} [${m.ref.scopeKind}]` +
            (m.status !== "ok" ? ` (${m.status})` : ""),
        )
      : ["  (no members)"];
    const subtitle = note
      ? [note, "", orchLine, "Members:", ...memberLines]
      : [orchLine, "Members:", ...memberLines];
    note = "";

    const REASSIGN = "Reassign orchestrator";
    const ADD_MEMBER = "Add member";
    const REMOVE_MEMBER = "Remove member…";
    const RENAME = "Rename team";
    const REGEN = "Regenerate orchestrator prompt";
    const DELETE = "Delete team";
    const BACK_OPT = "Back";
    const choice = await pickOption(`Team: ${team.name}`, subtitle, [
      REASSIGN,
      ADD_MEMBER,
      REMOVE_MEMBER,
      RENAME,
      REGEN,
      DELETE,
      BACK_OPT,
    ]);
    if (choice === null || choice === BACK_OPT) return "";

    if (choice === REASSIGN) {
      const oldOrch = team.orchestrator;
      const excludeFiles = team.members.map((m) => m.file);
      const ref = await assignAgentToSlot("orchestrator", {
        rankByRole: true,
        excludeFiles,
        warnOnAssign: true,
        ctx,
      });
      if (ref) {
        if (oldOrch) stripOrchestratorPromptBlock(oldOrch, team.id, searchIndex);
        teams = setOrchestrator(teams, team.id, ref);
        saveTeams(teams);
        note = `Orchestrator reassigned. ${regenerateOrchestratorPrompt(getTeam(teams, team.id), buildSearchIndex(cwd, cwdAgentsDir, cfg))}`;
      } else {
        note = "Reassign cancelled.";
      }
    } else if (choice === ADD_MEMBER) {
      const excludeFiles = [
        ...(team.orchestrator ? [team.orchestrator.file] : []),
        ...team.members.map((m) => m.file),
      ];
      const ref = await assignAgentToSlot("member", { rankByRole: false, excludeFiles, ctx });
      if (ref) {
        teams = addMember(teams, team.id, ref);
        saveTeams(teams);
        note = `Added ${ref.name}. ${regenerateOrchestratorPrompt(getTeam(teams, team.id), buildSearchIndex(cwd, cwdAgentsDir, cfg))}`;
      } else {
        note = "Add member cancelled.";
      }
    } else if (choice === REMOVE_MEMBER) {
      if (team.members.length === 0) {
        note = "No members to remove.";
        continue;
      }
      const memberOptions = team.members.map((m) => `${m.name} [${m.scopeKind}]`);
      const memberChoice = await pickOption("Remove which member?", [], memberOptions);
      if (memberChoice !== null) {
        const idx = memberOptions.indexOf(memberChoice);
        const removed = team.members[idx];
        teams = removeMember(teams, team.id, removed.file);
        saveTeams(teams);
        note = `Removed ${removed.name}. ${regenerateOrchestratorPrompt(getTeam(teams, team.id), buildSearchIndex(cwd, cwdAgentsDir, cfg))}`;
      }
    } else if (choice === RENAME) {
      const newName = await askLine("New team name: ", undefined, team.name);
      if (newName === null || newName === BACK) {
        note = "Rename cancelled.";
      } else if (newName && newName !== team.name) {
        if (teamByName(teams, newName)) {
          note = `A team named "${newName}" already exists — rename cancelled.`;
        } else {
          teams = renameTeam(teams, team.id, newName);
          saveTeams(teams);
          note = `Renamed to "${newName}". ${regenerateOrchestratorPrompt(getTeam(teams, team.id), searchIndex)}`.trim();
        }
      }
    } else if (choice === REGEN) {
      note = regenerateOrchestratorPrompt(team, searchIndex);
    } else if (choice === DELETE) {
      const typed = await askLine(
        `Type "${team.name}" to confirm delete (anything else cancels): `,
      );
      if (typed === team.name) {
        if (team.orchestrator) stripOrchestratorPromptBlock(team.orchestrator, team.id, searchIndex);
        saveTeams(deleteTeam(teams, team.id));
        return `Deleted team "${team.name}".`;
      }
      note = "Delete cancelled.";
    }
  }
}

async function deleteTeamFlow(teamId, ctx) {
  const teams = loadTeams();
  const team = getTeam(teams, teamId);
  if (!team) return "Team no longer exists.";
  const typed = await askLine(
    `Type "${team.name}" to confirm delete (anything else cancels): `,
  );
  if (typed !== team.name) return "Delete cancelled.";
  if (team.orchestrator) {
    const searchIndex = buildSearchIndex(ctx.cwd, ctx.cwdAgentsDir, ctx.cfg);
    stripOrchestratorPromptBlock(team.orchestrator, team.id, searchIndex);
  }
  saveTeams(deleteTeam(teams, team.id));
  return `Deleted team "${team.name}".`;
}

module.exports = {
  viewFile,
  runAgentSession,
  resumeSession,
  pickAgentAndResume,
  editAgent,
  deleteAgent,
  untrackPluginAgent,
  trackPluginAgent,
  toggleTrackedPluginAgent,
  searchFlow,
  addProjectFolder,
  pickCopyTarget,
  copyAgentFlow,
  buildManualTemplate,
  renderStatusScreen,
  runClaudeGenerate,
  describeClaudeError,
  generateDescription,
  generateAgentFile,
  runClaudeInteractive,
  buildInteractivePrompt,
  manualCreateFallback,
  createFlow,
  promoteAgentToLead,
  resolveRef,
  buildRosterBlock,
  upsertManagedBlock,
  stripManagedBlock,
  regenerateOrchestratorPrompt,
  stripOrchestratorPromptBlock,
  buildAssignablePool,
  assignAgentToSlot,
  buildTeamFlow,
  teamDetailFlow,
  deleteTeamFlow,
};
