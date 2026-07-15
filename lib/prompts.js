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
const { computeViewport } = require("./util");

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

// Runs promptText/tmpLabel through $EDITOR/$VISUAL (nano/vim/notepad),
// seeded with `seedValue`. Save & close to continue; lines starting with
// "#" are treated as instructional comments and stripped.
function editInExternalEditor(promptText, tmpLabel, seedValue) {
  const tmpFile = path.join(
    os.tmpdir(),
    `agent-wizard-${tmpLabel}-${process.pid}.md`,
  );
  const header = `# ${promptText}\n# Lines starting with '#' are ignored. Save and close this file to continue.\n\n`;
  fs.writeFileSync(tmpFile, header + (seedValue || ""), "utf8");
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
  if (res.error) return seedValue || "";
  return content
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .trim();
}

// Multi-line variant of askLine: type inline like a normal field (Enter
// inserts a newline), for tasks/guidelines-style free text. Ctrl+D confirms
// and returns the buffer. Ctrl+E hands the current buffer off to
// $EDITOR/$VISUAL (nano/vim/notepad) for real line editing, then drops back
// into the inline field with the result so it can still be reviewed/tweaked
// before confirming. Shift+Tab/Esc behave like askLine (BACK / cancel).
async function askMultiline(promptText, spellSlot, initialValue, tmpLabel) {
  let buffer = initialValue || "";
  let cursor = buffer.length;
  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "nano");

  process.stdout.write(clearScreen());
  try {
    for (;;) {
      const lines = buffer.split("\n");
      let remaining = cursor;
      let curLine = 0;
      for (; curLine < lines.length - 1; curLine++) {
        if (remaining <= lines[curLine].length) break;
        remaining -= lines[curLine].length + 1;
      }
      const curCol = remaining;

      let out = frameHome() + renderSpellEscape(spellSlot);
      out += bold("Agent Wizard") + "\n\n";
      out += promptText + "\n\n";
      lines.forEach((line, i) => {
        if (i === curLine) {
          const before = line.slice(0, curCol);
          const atCursor = curCol < line.length ? line[curCol] : " ";
          const after = line.slice(curCol + 1);
          out += before + reverse(atCursor) + after + "\n";
        } else {
          out += line + "\n";
        }
      });
      out += "\n";
      out +=
        dim(
          `Enter newline   Ctrl+D confirm   Ctrl+E open ${editor}   Shift+Tab back   Esc cancel`,
        ) + "\n";
      process.stdout.write(finalizeFrame(out));
      setRaw(true);
      const key = await waitForKey();
      if (key.ctrl && key.name === "c") process.exit(0);
      else if (key.ctrl && key.name === "d") return buffer.trim();
      else if (key.ctrl && key.name === "e") {
        exitAltScreen();
        setRaw(false);
        pauseKeyCapture();
        buffer = editInExternalEditor(promptText, tmpLabel, buffer);
        cursor = buffer.length;
        resumeKeyCapture();
        enterAltScreen();
        process.stdout.write(clearScreen());
      } else if (key.name === "escape") return null;
      else if (key.name === "tab" && key.shift) return BACK;
      else if (key.name === "return" || key.name === "enter") {
        buffer = buffer.slice(0, cursor) + "\n" + buffer.slice(cursor);
        cursor++;
      } else if (key.name === "left") cursor = Math.max(0, cursor - 1);
      else if (key.name === "right")
        cursor = Math.min(buffer.length, cursor + 1);
      else if (key.name === "up" || key.name === "down") {
        // move cursor a line up/down, keeping column where possible
        const lineStart = cursor - curCol;
        if (key.name === "up" && curLine > 0) {
          const prevLine = lines[curLine - 1];
          const col = Math.min(curCol, prevLine.length);
          cursor = lineStart - prevLine.length - 1 + col;
        } else if (key.name === "down" && curLine < lines.length - 1) {
          const nextLine = lines[curLine + 1];
          const col = Math.min(curCol, nextLine.length);
          cursor = lineStart + lines[curLine].length + 1 + col;
        }
      } else if (key.name === "home") cursor -= curCol;
      else if (key.name === "end") cursor += lines[curLine].length - curCol;
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

async function pickOption(
  title,
  subtitleLines,
  options,
  spellSlot,
  enableBack = false,
) {
  let idx = 0;
  let scrollOffset = 0;

  process.stdout.write(clearScreen());
  try {
    for (;;) {
      const termRows = process.stdout.rows || 24;
      const chrome = 3 /* title + blank + hint */ + subtitleLines.length;
      const viewHeight = Math.max(3, termRows - chrome);
      scrollOffset = computeViewport(
        options.length,
        idx,
        scrollOffset,
        viewHeight,
      );
      renderMenu(
        title,
        subtitleLines,
        options,
        idx,
        spellSlot,
        enableBack,
        scrollOffset,
        viewHeight,
      );
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
