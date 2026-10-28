import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { isLongRunningCommand } from '../../../src/main/services/terminal-attention/background-command';

describe('isLongRunningCommand', () => {
  it.each([
    'npm run dev',
    'npm start',
    'yarn start',
    'npm run test:watch',
    'npm run test:ui',
    'npm run e2e:open',
    'npm run storybook',
    'npm run test -- --watch',
    'jest --watchAll',
    'npx tsc -w',
    'npx vitest --ui',
    'npx playwright test --ui',
    'gradle build --continuous',
    'ng serve',
    'next dev',
    'npx vite',
    'vite preview',
    'uvicorn main:app --reload',
    'flask run',
    'rails s',
    'python3 manage.py runserver',
    'python3 -m http.server 8000',
    'exec python3 -m http.server 51885 --bind 127.0.0.1',
    'xvfb-run -a npm run dev',
    'xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run dev',
    'timeout 600 npm run dev',
    'cd app && npm run dev > dev.log 2>&1',
    'npm run build && npm start',
    'npm install && npm run storybook',
    'cargo build && cargo run',
    'go run .',
    'npm run build && node dist/main.js',
    'node server.js',
    './bin/server',
    'java -jar build/libs/app.jar',
    'docker build -t app . && docker run -p 8080:80 app',
    'docker compose up --build',
    'tail -f build.log',
    'docker logs -f web',
    'nodemon --exec "npm test"',
    'watchexec -e rs cargo test',
    'ls *.py | entr pytest',
    'sleep infinity',
  ])('treats `%s` as long-running', (command) => {
    expect(isLongRunningCommand(command)).toBe(true);
  });

  it.each([
    'npm test > test.log 2>&1',
    'npm test > test.log 2>&1; echo exit=$?',
    'timeout 1500 npm test > npm-test.log 2>&1; echo "exit $?"',
    'xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run test:e2e > e2e.log 2>&1',
    '(npm run build > build.log 2>&1; echo BUILD_EXIT=$?)',
    'until grep -q passed e2e.log; do sleep 5; done',
    'for i in 1 2 3; do npx vitest run > run$i.log; done',
    'bash scripts/test.sh',
    'sleep 900; echo done',
    'npm install --save-dev typescript',
    'npx vitest run tests/main/services/http-server.service.test.ts',
    'cargo build --release',
    'go test ./...',
    './gradlew test',
    './dist/pwsh -NoProfile -Command "$PSVersionTable"',
    'docker run --rm node:22 npm test',
    'docker compose up -d',
    'git push && gh run watch',
    "python3 -I - <<'EOF'\nprint('hi')\nEOF",
  ])('does not treat `%s` as long-running', (command) => {
    expect(isLongRunningCommand(command)).toBe(false);
  });

  // Background commands Claude ran in real sessions, with paths replaced. `hold` is whether the
  // command exited on its own and Claude resumed after it; servers were marked by hand.
  it('holds the recorded background commands that finished, and no recorded server', () => {
    const recorded = JSON.parse(
      readFileSync(`${__dirname}/../../fixtures/claude/background-commands.json`, 'utf-8')
    ) as { command: string; hold: boolean }[];
    const misjudged = recorded.filter(
      ({ command, hold }) => isLongRunningCommand(command) === hold
    );
    expect(misjudged).toEqual([]);
  });
});
