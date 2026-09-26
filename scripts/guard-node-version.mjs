#!/usr/bin/env node

// Node 22.13+: the CLI's commander and inquirer and the dev tools (ESLint, jsdom) need it, and it
// covers `node --env-file-if-exists` (22.9+) in the server's dev and start scripts. Keep it equal to
// engines.node in package.json (`pnpm run engines:check` compares them).
const MIN = [22, 13];
const current = process.versions.node || "0.0.0";
const [major, minor] = current.split(".").map((part) => Number.parseInt(part || "0", 10));

const tooOld =
  Number.isNaN(major) ||
  Number.isNaN(minor) ||
  major < MIN[0] ||
  (major === MIN[0] && minor < MIN[1]);
if (tooOld) {
  console.error(`Blocked: Node.js ${MIN.join(".")}+ is required.`);
  console.error(`Detected: ${current}`);
  console.error(`Install Node ${MIN.join(".")}+ and retry.`);
  process.exit(1);
}
