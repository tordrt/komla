import { describe, expect, it } from 'vitest';

import { setCodexMcpServer } from '../../../src/main/lib/codex-mcp-config';

const USER_CONFIG = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.komla]',
  'url = "http://127.0.0.1:62000/api/v1/mcp"',
  '',
  '[projects."/worktree"]',
  'trust_level = "trusted"',
  '',
  '[hooks.state]',
  'trusted_hash = "abc123"',
  '',
  '[tui]',
  'status_line = ["model-name", "context-remaining"]',
  '',
].join('\n');

function expectUserConfigPreserved(config: string): void {
  expect(config).toContain('[projects."/worktree"]');
  expect(config).toContain('trust_level = "trusted"');
  expect(config).toContain('[hooks.state]');
  expect(config).toContain('trusted_hash = "abc123"');
  expect(config).toContain('[tui]');
  expect(config).toContain('status_line = ["model-name", "context-remaining"]');
}

describe('Codex MCP config mutation', () => {
  it('replaces only the Komla MCP table', () => {
    const updated = setCodexMcpServer(USER_CONFIG, 'http://127.0.0.1:63000/api/v1/mcp');

    expectUserConfigPreserved(updated);
    expect(updated).toContain('[mcp_servers.komla]');
    expect(updated).toContain('url = "http://127.0.0.1:63000/api/v1/mcp"');
    expect(updated).not.toContain('62000');
    expect(updated.match(/\[mcp_servers\.komla\]/g)).toHaveLength(1);
  });

  it('writes a stdio Komla MCP server in place of a URL server', () => {
    const next = setCodexMcpServer(
      'model = "gpt-5"\n\n[mcp_servers.komla]\nurl = "http://127.0.0.1:62000/api/v1/mcp"\n',
      { command: '/home/dev/.komla/helpers/komla', args: ['mcp'] }
    );

    expect(next).toBe(
      'model = "gpt-5"\n\n[mcp_servers.komla]\ncommand = "/home/dev/.komla/helpers/komla"\nargs = ["mcp"]\n'
    );
  });

  it('removes only the Komla MCP table', () => {
    const updated = setCodexMcpServer(USER_CONFIG, null);

    expectUserConfigPreserved(updated);
    expect(updated).not.toContain('[mcp_servers.komla]');
    expect(updated).not.toContain('62000');
  });

  it.each([['host mutator', setCodexMcpServer]])(
    'does not interpret table headers inside multiline strings (%s)',
    (_name, mutate) => {
      const config = [
        'instructions = """',
        'Keep this example unchanged:',
        '[mcp_servers.komla]',
        '"""',
        '',
        "developer_instructions = '''",
        '[projects."literal]example"]',
        "'''",
        '',
        '[mcp_servers.komla]',
        'url = "http://localhost:11111/api/v1/mcp"',
        '',
        '[projects."/worktree"]',
        'trust_level = "trusted"',
        '',
      ].join('\n');
      const multilineValue = [
        'instructions = """',
        'Keep this example unchanged:',
        '[mcp_servers.komla]',
        '"""',
        '',
        "developer_instructions = '''",
        '[projects."literal]example"]',
        "'''",
      ].join('\n');

    const updated = mutate(config, null);

    expect(updated).toContain(multilineValue);
    expect(updated).toContain('[projects."/worktree"]');
    expect(updated).not.toContain('http://localhost:11111/api/v1/mcp');
  });

  it.each([['host mutator', setCodexMcpServer]])(
    'recognizes table boundaries containing a quoted closing bracket (%s)',
    (_name, mutate) => {
      const config = [
        '[mcp_servers.komla]',
        'url = "http://localhost:11111/api/v1/mcp"',
        '',
        '[projects."repo]name"]',
        'trust_level = "trusted"',
        '',
      ].join('\n');

    const updated = mutate(config, null);

    expect(updated).toContain('[projects."repo]name"]');
    expect(updated).toContain('trust_level = "trusted"');
  });

  it.each([['host mutator', setCodexMcpServer]])(
    'preserves consecutive blank lines inside multiline strings (%s)',
    (_name, mutate) => {
      const instructions = [
        'instructions = """',
        'first paragraph',
        '',
        '',
        'second paragraph',
        '"""',
      ].join('\n');
      const config = [
        instructions,
        '',
        '[mcp_servers.komla]',
        'url = "http://localhost:11111/api/v1/mcp"',
        '',
      ].join('\n');

    const updated = mutate(config, 'http://localhost:22222/api/v1/mcp');

    expect(updated).toContain(instructions);
  });

  it.each([['host mutator', setCodexMcpServer]])(
    'recognizes escaped basic quoted Komla table keys (%s)',
    (_name, mutate) => {
      const config = [
        '["mcp_\\u0073ervers"."ko\\u006dla"]',
        'url = "http://localhost:11111/api/v1/mcp"',
        '',
        '[tui]',
        'status_line = ["model-name"]',
        '',
      ].join('\n');

    const updated = mutate(config, 'http://localhost:22222/api/v1/mcp');

    expect(updated).not.toContain('["mcp_\\u0073ervers"."ko\\u006dla"]');
    expect(updated).not.toContain('11111');
    expect(updated.match(/\[mcp_servers\.komla\]/g)).toHaveLength(1);
    expect(updated).toContain('[tui]\nstatus_line = ["model-name"]');
  });
});
