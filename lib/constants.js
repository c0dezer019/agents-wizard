"use strict";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const TABS = ["project", "user", "plugin", "sessions"];

const BUILTIN_NAMES = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "claude",
]);

const MIN_DESC_WIDTH = 10;
const MAX_NAME_WIDTH = 32;
const MAX_SOURCE_WIDTH = 30;

module.exports = {
  TABS,
  BUILTIN_NAMES,
  MIN_DESC_WIDTH,
  MAX_NAME_WIDTH,
  MAX_SOURCE_WIDTH,
};
