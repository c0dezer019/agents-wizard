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
} = require("./util");
const { saveConfig } = require("./config");
const {
  buildSearchIndex,
  filterSearchIndex,
  resolveBookmarkEntries,
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

const ADD_AGENT_PROMPT_FILE = path.join(__dirname, "..", "add_agent.md");
const ADD_AGENT_INTERACTIVE_PROMPT_FILE = path.join(
  __dirname,
  "..",
  "finish_agent_interactive.md",
);

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

function runAgentSession(agent) {
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();
  process.stdout.write(
    `\nStarting claude --agent ${agent.name} (exit the session normally to return to the wizard)...\n\n`,
  );

  const res = spawnSync("claude", ["--agent", agent.name], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  resumeKeyCapture();
  enterAltScreen();
  if (res.error)
    return `Could not launch "claude --agent ${agent.name}": ${res.error.message}`;
  return "";
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
      if (row) status = runAgentSession(row);
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
        if (choice === "Launch") status = runAgentSession(row);
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

async function manualCreateFallback(
  scopeDir,
  target,
  name,
  warning,
  imageLogo,
  spellBase64,
) {
  const description = await askLine(
    "One-line description (this is the delegation trigger Claude reads): ",
    pickSpellSlot(imageLogo, spellBase64),
  );
  if (description === null) return "Create cancelled.";
  const dirExisted = isDir(scopeDir);
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(target, buildManualTemplate(name, description), "utf8");
  const { editor, res } = openEditor(target);
  let note = `${warning} Created ${target}.`;
  if (res.error)
    note += ` (Could not launch editor "${editor}": ${res.error.message})`;
  if (!dirExisted)
    note += " New agents/ directory — restart Claude Code to pick it up.";
  return note;
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

async function createFlow(data, tabKey, imageLogo, spellBase64) {
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

  for (;;) {
    answers = await collectCreateAnswers(spellSlot, answers, 0);
    if (!answers) return "Create cancelled."; // Esc: bail out, nothing written
    ({ name, role, seniority, tasks, guidelines } = answers);

    if (!name) return "Create cancelled (empty name).";
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return "Create cancelled: name must be lowercase letters/digits/hyphens, starting with a letter.";
    }
    if (BUILTIN_NAMES.has(name)) {
      return `Create cancelled: "${name}" is a built-in agent name and can't be shadowed.`;
    }
    target = path.join(scopeDir, `${name}.md`);
    if (fs.existsSync(target)) {
      return `Create cancelled: ${target} already exists — use Edit instead.`;
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
    if (finishChoice === null) return "Create cancelled."; // Esc: cancel outright
    if (finishChoice === BACK) {
      // Shift+Tab on the finish menu: re-enter the text steps starting
      // from the last one (guidelines), prefilled with prior answers.
      answers = await collectCreateAnswers(
        spellSlot,
        answers,
        CREATE_STEPS.length - 1,
      );
      if (!answers) return "Create cancelled.";
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
  return note;
}

module.exports = {
  viewFile,
  runAgentSession,
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
};
