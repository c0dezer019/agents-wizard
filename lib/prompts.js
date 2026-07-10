"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  clearScreen,
  frameHome,
  bold,
  reverse,
  dim,
  finalizeFrame,
} = require("./theme");
const {
  waitForKey,
  setRaw,
  exitAltScreen,
  enterAltScreen,
  pauseKeyCapture,
  resumeKeyCapture,
  NON_TEXT_KEY_NAMES,
} = require("./keys");
const { renderSpellEscape } = require("./image");
const { renderMenu } = require("./render");

// ---------------------------------------------------------------------------
// Text-input prompts and menus
// ---------------------------------------------------------------------------

// Sentinel returned by askLine/pickOption when the user asks to go back to
// the previous step (Shift+Tab), distinct from `null` (cancel, Esc) and a
// normal string/option value.
const BACK = Symbol("back");

async function askLine(promptText, spellSlot, initialValue) {
  let buffer = initialValue || "";
  let cursor = buffer.length;

  process.stdout.write(clearScreen());
  try {
    for (;;) {
      const before = buffer.slice(0, cursor);
      const atCursor = cursor < buffer.length ? buffer[cursor] : " ";
      const after = buffer.slice(cursor + 1);
      let out = frameHome() + renderSpellEscape(spellSlot);
      out += bold("Agent Wizard") + "\n\n";
      out += promptText + before + reverse(atCursor) + after + "\n\n";
      out += dim("Enter confirm   ←/→ move   Shift+Tab back   Esc cancel") + "\n";
      process.stdout.write(finalizeFrame(out));
      setRaw(true);
      const key = await waitForKey();
      if (key.ctrl && key.name === "c") process.exit(0);
      else if (key.name === "return" || key.name === "enter")
        return buffer.trim();
      else if (key.name === "escape") return null;
      else if (key.name === "tab" && key.shift) return BACK;
      else if (key.name === "left") cursor = Math.max(0, cursor - 1);
      else if (key.name === "right")
        cursor = Math.min(buffer.length, cursor + 1);
      else if (key.name === "home") cursor = 0;
      else if (key.name === "end") cursor = buffer.length;
      else if (key.name === "backspace") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
        }
      } else if (key.name === "delete") {
        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
      } else if (
        key.str &&
        !key.ctrl &&
        !key.meta &&
        !NON_TEXT_KEY_NAMES.has(key.name) &&
        !key.str.startsWith("\x1B")
      ) {
        buffer = buffer.slice(0, cursor) + key.str + buffer.slice(cursor);
        cursor += key.str.length;
      }
    }
  } finally {
    process.stdout.write(clearScreen());
  }
}

function openEditor(filePath) {
  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "nano");
  exitAltScreen();
  setRaw(false);
  pauseKeyCapture();

  const res = spawnSync(editor, [filePath], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  resumeKeyCapture();
  enterAltScreen();
  return { editor, res };
}

// Multi-line variant of askLine: instead of typing inline, Enter opens
// $EDITOR/$VISUAL (nano/vim/notepad) on a temp file seeded with any prior
// answer, for tasks/guidelines-style free text. Save & close to continue;
// lines starting with "#" are treated as instructional comments and
// stripped. Shift+Tab/Esc behave like askLine (BACK / cancel) but are only
// honored on the pre-editor confirm screen, since a running editor can't be
// interrupted the same way.
async function askMultiline(promptText, spellSlot, initialValue, tmpLabel) {
  process.stdout.write(clearScreen());
  try {
    for (;;) {
      let out = frameHome() + renderSpellEscape(spellSlot);
      out += bold("Agent Wizard") + "\n\n";
      out += promptText + "\n\n";
      if (initialValue) {
        out +=
          dim("Current answer:") +
          "\n" +
          initialValue
            .split("\n")
            .map((l) => "  " + l)
            .join("\n") +
          "\n\n";
      }
      const editor =
        process.env.VISUAL ||
        process.env.EDITOR ||
        (process.platform === "win32" ? "notepad" : "nano");
      out +=
        dim(
          `Enter opens ${editor} for multi-line input   Shift+Tab back   Esc cancel`,
        ) + "\n";
      process.stdout.write(finalizeFrame(out));
      setRaw(true);
      const key = await waitForKey();
      if (key.ctrl && key.name === "c") process.exit(0);
      else if (key.name === "escape") return null;
      else if (key.name === "tab" && key.shift) return BACK;
      else if (key.name === "return") break;
    }
  } finally {
    process.stdout.write(clearScreen());
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `agent-wizard-${tmpLabel}-${process.pid}.md`,
  );
  const header = `# ${promptText}\n# Lines starting with '#' are ignored. Save and close this file to continue.\n\n`;
  fs.writeFileSync(tmpFile, header + (initialValue || ""), "utf8");
  const { res } = openEditor(tmpFile);
  let content = "";
  try {
    content = fs.readFileSync(tmpFile, "utf8");
    // eslint-disable-next-line no-empty
  } catch {}
  try {
    fs.unlinkSync(tmpFile);
    // eslint-disable-next-line no-empty
  } catch {}
  process.stdout.write(clearScreen());
  if (res.error) return initialValue || "";
  return content
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .trim();
}

async function pickOption(
  title,
  subtitleLines,
  options,
  spellSlot,
  enableBack = false,
) {
  let idx = 0;

  process.stdout.write(clearScreen());
  try {
    for (;;) {
      renderMenu(title, subtitleLines, options, idx, spellSlot, enableBack);
      setRaw(true);
      const key = await waitForKey();
      if (key.ctrl && key.name === "c") process.exit(0);
      else if (key.name === "up")
        idx = (idx + options.length - 1) % options.length;
      else if (key.name === "down") idx = (idx + 1) % options.length;
      else if (enableBack && key.name === "tab" && key.shift) return BACK;
      else if (key.name === "escape" || key.name === "q") return null;
      else if (key.name === "return") return options[idx];
    }
  } finally {
    process.stdout.write(clearScreen());
  }
}

module.exports = { askLine, askMultiline, openEditor, pickOption, BACK };
