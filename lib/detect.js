"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Codebase stack detection + agent recommendation matching
// ---------------------------------------------------------------------------

const STACK_KEYWORDS = [
  "react", "vue", "angular", "svelte", "next", "nuxt", "remix", "gatsby",
  "express", "fastify", "nestjs", "koa", "hapi",
  "django", "flask", "fastapi", "pyramid",
  "rails", "sinatra",
  "spring", "quarkus", "micronaut",
  "laravel", "symfony",
  "docker", "kubernetes", "k8s", "terraform", "ansible", "helm",
  "graphql", "grpc",
  "postgres", "postgresql", "mysql", "mongodb", "redis", "sqlite", "dynamodb",
  "aws", "gcp", "azure",
  "python", "node", "nodejs", "typescript", "javascript",
  "go", "golang", "rust", "ruby", "java", "php", "kotlin", "swift", "dotnet", "csharp",
  "jest", "vitest", "pytest", "mocha", "cypress", "playwright",
  "tailwind", "webpack", "vite", "babel",
  "electron", "flutter", "android", "ios", "swiftui",
  "solidity", "ethereum", "web3",
  "pandas", "numpy", "tensorflow", "pytorch", "sklearn",
];

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function matchKeywords(text) {
  const found = new Set();
  const lower = (text || "").toLowerCase();
  for (const kw of STACK_KEYWORDS) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
    if (re.test(lower)) found.add(kw);
  }
  return found;
}

function detectStackTags(cwd) {
  const tags = new Set();
  if (!cwd) return tags;

  const pkg = readJSON(path.join(cwd, "package.json"));
  if (pkg) {
    tags.add("node");
    tags.add("javascript");
    const deps = Object.assign(
      {},
      pkg.dependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
    );
    for (const kw of matchKeywords(Object.keys(deps).join(" "))) tags.add(kw);
    if (fs.existsSync(path.join(cwd, "tsconfig.json"))) tags.add("typescript");
  }

  for (const f of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"]) {
    const content = readText(path.join(cwd, f));
    if (content !== null) {
      tags.add("python");
      for (const kw of matchKeywords(content)) tags.add(kw);
    }
  }

  const goMod = readText(path.join(cwd, "go.mod"));
  if (goMod !== null) {
    tags.add("go");
    for (const kw of matchKeywords(goMod)) tags.add(kw);
  }

  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) tags.add("rust");

  const gemfile = readText(path.join(cwd, "Gemfile"));
  if (gemfile !== null) {
    tags.add("ruby");
    for (const kw of matchKeywords(gemfile)) tags.add(kw);
  }

  if (
    fs.existsSync(path.join(cwd, "pom.xml")) ||
    fs.existsSync(path.join(cwd, "build.gradle")) ||
    fs.existsSync(path.join(cwd, "build.gradle.kts"))
  ) {
    tags.add("java");
  }

  if (fs.existsSync(path.join(cwd, "composer.json"))) tags.add("php");
  if (listDir(cwd).some((f) => f.endsWith(".csproj"))) tags.add("dotnet");

  if (
    fs.existsSync(path.join(cwd, "Dockerfile")) ||
    fs.existsSync(path.join(cwd, "docker-compose.yml")) ||
    fs.existsSync(path.join(cwd, "docker-compose.yaml"))
  ) {
    tags.add("docker");
  }

  if (listDir(cwd).some((f) => f.endsWith(".tf"))) tags.add("terraform");

  return tags;
}

function agentStackTags(agent) {
  return matchKeywords(`${agent.name} ${agent.description}`);
}

function isRecommended(agent, stackTags) {
  if (!stackTags || stackTags.size === 0) return false;
  const agentTags = agentStackTags(agent);
  for (const t of agentTags) if (stackTags.has(t)) return true;
  return false;
}

module.exports = {
  STACK_KEYWORDS,
  detectStackTags,
  agentStackTags,
  isRecommended,
};
