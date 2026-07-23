"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Teams: named groups of agents with one orchestrator slot + a growing member
// roster. Persisted separately from lib/config.js (which hardcodes its own
// two fields) — mirrors the load/validate/save shape of lib/session-log.js.
// Pure core (validators, mutators, queries) is kept free of fs access beyond
// the load/save boundary so it's testable headlessly, per the convention
// noted at lib/scan.js:19.
// ---------------------------------------------------------------------------

const MAX_TEAMS = 200;

function teamsFile() {
  return path.join(os.homedir(), ".claude", "agent-wizard", "teams.json");
}

function isValidRef(r) {
  return (
    r &&
    typeof r === "object" &&
    typeof r.name === "string" &&
    typeof r.scopeKind === "string" &&
    typeof r.file === "string" &&
    typeof r.description === "string"
  );
}

function isValidTeam(t) {
  return (
    t &&
    typeof t === "object" &&
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    (t.orchestrator === null || isValidRef(t.orchestrator)) &&
    Array.isArray(t.members) &&
    t.members.every(isValidRef) &&
    typeof t.createdAt === "number" &&
    typeof t.updatedAt === "number"
  );
}

function loadTeams() {
  try {
    const raw = fs.readFileSync(teamsFile(), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.teams) ? data.teams.filter(isValidTeam) : [];
  } catch {
    return [];
  }
}

function saveTeams(teams) {
  const file = teamsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const trimmed = teams.slice(0, MAX_TEAMS);
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, teams: trimmed }, null, 2) + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function makeAgentRef(agent) {
  return {
    name: agent.name,
    scopeKind: agent.scopeKind,
    file: agent.file,
    description: agent.description || "",
  };
}

function makeTeamId() {
  return `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function teamByName(teams, name) {
  const lower = name.trim().toLowerCase();
  return teams.find((t) => t.name.trim().toLowerCase() === lower) || null;
}

function getTeam(teams, id) {
  return teams.find((t) => t.id === id) || null;
}

// ---------------------------------------------------------------------------
// Pure mutators — (teams, ...) => newTeams. Callers are responsible for
// calling saveTeams() with the result.
// ---------------------------------------------------------------------------

function createTeam(teams, name) {
  const now = Date.now();
  const team = {
    id: makeTeamId(),
    name,
    orchestrator: null,
    members: [],
    createdAt: now,
    updatedAt: now,
  };
  return [...teams, team];
}

function updateTeam(teams, id, patch) {
  const now = Date.now();
  return teams.map((t) =>
    t.id === id ? { ...t, ...patch, id: t.id, updatedAt: now } : t,
  );
}

function deleteTeam(teams, id) {
  return teams.filter((t) => t.id !== id);
}

function renameTeam(teams, id, name) {
  return updateTeam(teams, id, { name });
}

function setOrchestrator(teams, id, ref) {
  return updateTeam(teams, id, { orchestrator: ref });
}

function addMember(teams, id, ref) {
  const team = getTeam(teams, id);
  if (!team) return teams;
  if (team.members.some((m) => m.file === ref.file)) return teams;
  return updateTeam(teams, id, { members: [...team.members, ref] });
}

function removeMember(teams, id, file) {
  const team = getTeam(teams, id);
  if (!team) return teams;
  return updateTeam(teams, id, {
    members: team.members.filter((m) => m.file !== file),
  });
}

module.exports = {
  teamsFile,
  isValidRef,
  isValidTeam,
  loadTeams,
  saveTeams,
  makeAgentRef,
  makeTeamId,
  teamByName,
  getTeam,
  createTeam,
  updateTeam,
  deleteTeam,
  renameTeam,
  setOrchestrator,
  addMember,
  removeMember,
};
