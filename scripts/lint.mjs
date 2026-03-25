import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const ROOT = process.cwd();
const SCAN_TARGETS = ["src", "server", "index.html", "vite.config.js", "package.json"];
const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".json"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".git", ".vite", "coverage"]);
const BLOCKED_PATTERNS = [
  { label: "merge-conflict marker", regex: /^<{7}|^={7}|^>{7}/m },
  { label: "debugger statement", regex: /\bdebugger\s*;?/m },
];

const violations = [];

function shouldScanFile(path) {
  return ALLOWED_EXTENSIONS.has(extname(path));
}

function scanFile(path) {
  const content = readFileSync(path, "utf-8");
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.regex.test(content)) {
      violations.push({ path, reason: pattern.label });
    }
  }
}

function walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const name = basename(path);
    if (IGNORED_DIRECTORIES.has(name)) return;
    for (const entry of readdirSync(path)) {
      walk(join(path, entry));
    }
    return;
  }

  if (shouldScanFile(path)) {
    scanFile(path);
  }
}

for (const target of SCAN_TARGETS) {
  walk(join(ROOT, target));
}

if (violations.length > 0) {
  console.error("Lint failed. Blocked patterns found:");
  for (const violation of violations) {
    console.error(`- ${violation.path}: ${violation.reason}`);
  }
  process.exit(1);
}

console.log("Lint passed: no blocked patterns found.");
