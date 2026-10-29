#!/usr/bin/env node
// Claude Code's PostToolUse hook (.claude/settings.json): formats a src/ or
// native/ file in the project right after an edit, so CI's format checks pass.
// It reads the hook's JSON on stdin and uses the oxfmt of the checkout that
// holds the file, which may be a worktree nested in the project, or rustfmt.
// Exit 2 shows its message to the agent.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OXFMT_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.json']);

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
  if (typeof filePath !== 'string') return null;
  const extension = path.extname(filePath);
  if (!OXFMT_EXTENSIONS.has(extension) && extension !== '.rs') return null;
  const file = path.resolve(projectDir, filePath);
  if (!isInside(projectDir, file)) return null;
  const root = checkoutRoot(file);
  if (!root) return null;
  const relative = path.relative(root, file);
  const scope = relative.split(path.sep)[0];
  if (scope === 'src' && OXFMT_EXTENSIONS.has(extension)) return runOxfmt(root, file, relative);
  if (scope === 'native' && extension === '.rs') return runRustfmt(root, file, relative);
  return null;
}

function runOxfmt(root, file, relative) {
  const oxfmt = path.join(root, 'node_modules', 'oxfmt', 'bin', 'oxfmt');
  if (!fs.existsSync(oxfmt)) {
    return `Couldn't format ${relative}: dependencies aren't installed here. Run \`npm run format\` before finishing.`;
  }
  const result = spawnSync(process.execPath, [oxfmt, file], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return null;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return `oxfmt couldn't format ${relative}:\n${output || result.error?.message || 'unknown error'}`;
}

// rustfmt reads the file on stdin, so it formats only that file and doesn't
// fail on a `mod` whose file the agent hasn't written yet. From native/, rustup
// picks the pinned toolchain and rustfmt reads native/rustfmt.toml.
// RUSTUP_AUTO_INSTALL=0 keeps rustup 1.28.1 and later from stalling the edit to
// install the toolchain.
function runRustfmt(root, file, relative) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const result = spawnSync('rustfmt', [], {
    cwd: path.join(root, 'native'),
    input: source,
    encoding: 'utf8',
    env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' },
  });
  if (result.error?.code === 'ENOENT') {
    return `Couldn't format ${relative}: rustfmt isn't installed (https://rustup.rs). Run \`npm run format:native\` before finishing.`;
  }
  if (result.status === 0) {
    if (result.stdout !== source) fs.writeFileSync(file, result.stdout);
    return null;
  }
  const output = (result.stderr ?? '').trim();
  // rustup's own errors: the pinned toolchain, or its rustfmt, is missing.
  if (/ is not installed/.test(output)) {
    return `Couldn't format ${relative}: rustup can't run rustfmt in native/:\n${output}`;
  }
  return `rustfmt couldn't format ${relative}:\n${output || result.error?.message || 'unknown error'}`;
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
