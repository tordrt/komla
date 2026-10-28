#!/usr/bin/env node
// Claude Code's PostToolUse hook (.claude/settings.json): formats a src/ file
// in the project right after an edit, so CI's format check passes. It reads the
// hook's JSON on stdin and uses the oxfmt of the checkout that holds the file,
// which may be a worktree nested in the project. Exit 2 shows its message to
// the agent.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.json']);

function checkoutRoot(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.oxfmtrc.json'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isInside(dir, file) {
  const relative = path.relative(realPath(dir), realPath(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function formatEditedFile(input, projectDir) {
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !EXTENSIONS.has(path.extname(filePath))) return null;
  const file = path.resolve(projectDir, filePath);
  if (!isInside(projectDir, file)) return null;
  const root = checkoutRoot(file);
  if (!root || path.relative(root, file).split(path.sep)[0] !== 'src') return null;
  const relative = path.relative(root, file);
  const oxfmt = path.join(root, 'node_modules', 'oxfmt', 'bin', 'oxfmt');
  if (!fs.existsSync(oxfmt)) {
    return `Couldn't format ${relative}: dependencies aren't installed here. Run \`npm run format\` before finishing.`;
  }
  const result = spawnSync(process.execPath, [oxfmt, file], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return null;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return `oxfmt couldn't format ${relative}:\n${output || result.error?.message || 'unknown error'}`;
}

module.exports = { formatEditedFile };

if (require.main === module) {
  let stdin = '';
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(stdin);
    } catch {
      return;
    }
    const problem = formatEditedFile(input, process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (problem) {
      console.error(problem);
      process.exitCode = 2;
    }
  });
}
