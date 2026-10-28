type MultilineString = 'basic' | 'literal' | null;

const BASIC_KEY_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function advanceMultilineString(line: string, initial: MultilineString): MultilineString {
  let multiline = initial;
  let quote: 'basic' | 'literal' | null = null;

  for (let i = 0; i < line.length; i++) {
    if (multiline !== null) {
      const delimiter = multiline === 'basic' ? '"""' : "'''";
      if (line.startsWith(delimiter, i) && (multiline === 'literal' || !isEscaped(line, i))) {
        multiline = null;
        i += 2;
      }
      continue;
    }

    if (quote !== null) {
      const delimiter = quote === 'basic' ? '"' : "'";
      if (line[i] === delimiter && (quote === 'literal' || !isEscaped(line, i))) quote = null;
      continue;
    }

    if (line[i] === '#') break;
    if (line.startsWith('"""', i)) {
      multiline = 'basic';
      i += 2;
    } else if (line.startsWith("'''", i)) {
      multiline = 'literal';
      i += 2;
    } else if (line[i] === '"') {
      quote = 'basic';
    } else if (line[i] === "'") {
      quote = 'literal';
    }
  }

  return multiline;
}

function getTableKeyParts(line: string): string[] | null {
  let index = 0;
  while (index < line.length && /\s/.test(line[index])) index++;
  if (line[index] !== '[') return null;

  const arrayTable = line[index + 1] === '[';
  const contentStart = index + (arrayTable ? 2 : 1);
  let quote: 'basic' | 'literal' | null = null;
  let contentEnd = -1;

  for (index = contentStart; index < line.length; index++) {
    const char = line[index];
    if (quote !== null) {
      const delimiter = quote === 'basic' ? '"' : "'";
      if (char === delimiter && (quote === 'literal' || !isEscaped(line, index))) quote = null;
      continue;
    }
    if (char === '"') {
      quote = 'basic';
    } else if (char === "'") {
      quote = 'literal';
    } else if (char === ']' && (!arrayTable || line[index + 1] === ']')) {
      contentEnd = index;
      index += arrayTable ? 2 : 1;
      break;
    }
  }

  if (contentEnd < 0) return null;
  while (index < line.length && /\s/.test(line[index])) index++;
  if (index < line.length && line[index] !== '#') return null;

  const parts: string[] = [];
  let partStart = contentStart;
  quote = null;
  for (let i = contentStart; i < contentEnd; i++) {
    const char = line[i];
    if (quote !== null) {
      const delimiter = quote === 'basic' ? '"' : "'";
      if (char === delimiter && (quote === 'literal' || !isEscaped(line, i))) quote = null;
    } else if (char === '"') {
      quote = 'basic';
    } else if (char === "'") {
      quote = 'literal';
    } else if (char === '.') {
      parts.push(line.slice(partStart, i).trim());
      partStart = i + 1;
    }
  }
  parts.push(line.slice(partStart, contentEnd).trim());
  return parts;
}

function decodeUnicodeEscape(
  value: string,
  markerIndex: number
): { decoded: string; endIndex: number } | null {
  const marker = value[markerIndex];
  const digits = marker === 'u' ? 4 : marker === 'U' ? 8 : 0;
  const hexadecimal = value.slice(markerIndex + 1, markerIndex + 1 + digits);
  if (digits === 0 || hexadecimal.length !== digits || !/^[\dA-Fa-f]+$/.test(hexadecimal)) {
    return null;
  }

  const codePoint = Number.parseInt(hexadecimal, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
  return { decoded: String.fromCodePoint(codePoint), endIndex: markerIndex + digits };
}

function decodeBasicQuotedKey(value: string): string | null {
  if (!value.startsWith('"') || !value.endsWith('"')) return null;

  let decoded = '';
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];
    if (char !== '\\') {
      decoded += char;
      continue;
    }

    const escape = value[++index];
    const simpleEscape = BASIC_KEY_ESCAPES[escape];
    if (simpleEscape !== undefined) {
      decoded += simpleEscape;
      continue;
    }

    const unicodeEscape = decodeUnicodeEscape(value, index);
    if (unicodeEscape === null) return null;
    decoded += unicodeEscape.decoded;
    index = unicodeEscape.endIndex;
  }
  return decoded;
}

function isNamedKey(value: string | undefined, name: string): boolean {
  if (value === undefined) return false;
  if (value === name) return true;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1) === name;
  return decodeBasicQuotedKey(value) === name;
}

function isKomlaMcpTable(parts: string[]): boolean {
  return isNamedKey(parts[0], 'mcp_servers') && isNamedKey(parts[1], 'komla');
}

/** A Komla MCP server reached over HTTP (a URL) or launched as a stdio command. */
export type CodexMcpServer = string | { command: string; args: string[] };

function komlaMcpTableBody(server: CodexMcpServer, newline: string): string {
  if (typeof server === 'string') return `url = ${JSON.stringify(server)}${newline}`;
  return `command = ${JSON.stringify(server.command)}${newline}args = ${JSON.stringify(server.args)}${newline}`;
}

function appendKomlaMcpTable(content: string, server: CodexMcpServer, newline: string): string {
  let separator = '';
  if (content.length > 0 && !content.endsWith(`${newline}${newline}`)) {
    separator = content.endsWith(newline) ? newline : `${newline}${newline}`;
  }
  return `${content}${separator}[mcp_servers.komla]${newline}${komlaMcpTableBody(server, newline)}`;
}

/**
 * Add, replace, or remove Codex's Komla MCP server without touching any other
 * config.toml tables.
 */
export function setCodexMcpServer(content: string, server: CodexMcpServer | null): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let multiline: MultilineString = null;
  let skippingKomlaTable = false;
  let hasKomlaState = false;

  for (const line of lines) {
    if (multiline === null) {
      const tableKeyParts = getTableKeyParts(line);
      if (tableKeyParts !== null) {
        skippingKomlaTable = isKomlaMcpTable(tableKeyParts);
        if (skippingKomlaTable) hasKomlaState = true;
      }
    }

    if (!skippingKomlaTable) kept.push(line);
    multiline = advanceMultilineString(line, multiline);
  }

  if (server === null && !hasKomlaState) return content;

  const preserved = kept.join(newline);
  if (server === null) return preserved;
  return appendKomlaMcpTable(preserved, server, newline);
}
