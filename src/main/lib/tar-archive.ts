/** A folder, file or link in a tar archive, by its path in the archive with `/` between names. */
export type TarEntry =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; content: Buffer; executable?: boolean }
  /** `target` is where the link leads, relative to the link's own folder. */
  | { kind: 'link'; path: string; target: string };

const BLOCK = 512;
const NAME_LENGTH = 100;

function writeText(header: Buffer, offset: number, length: number, text: string): void {
  header.write(text, offset, length, 'utf8');
}

/** An octal number, padded with zeros and ended with a NUL, as tar headers have them. */
function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeText(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function header(
  name: string,
  type: string,
  options: { size?: number; mode: number; linkName?: string; mtime: number }
): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeText(block, 0, NAME_LENGTH, name);
  writeOctal(block, 100, 8, options.mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, options.size ?? 0);
  writeOctal(block, 136, 12, options.mtime);
  block.fill(' ', 148, 156);
  writeText(block, 156, 1, type);
  if (options.linkName) writeText(block, 157, NAME_LENGTH, options.linkName);
  writeText(block, 257, 6, 'ustar\0');
  writeText(block, 263, 2, '00');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeText(block, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

/** Fits in a header's name field: short, and ASCII, which every tar reads the same way. */
function fitsHeader(text: string): boolean {
  return text.length < NAME_LENGTH && /^[\x20-\x7e]*$/.test(text);
}

/** One pax record, `<length> <key>=<value>\n`, whose length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const restBytes = Buffer.byteLength(rest);
  let length = restBytes + 1;
  while (String(length).length + restBytes !== length) length = String(length).length + restBytes;
  return `${length}${rest}`;
}

function padded(content: Buffer): Buffer[] {
  const rest = content.length % BLOCK;
  return rest === 0 ? [content] : [content, Buffer.alloc(BLOCK - rest)];
}

/** A pax header for whatever of the entry's path and link target a header can't hold. */
function paxHeader(name: string, linkName: string | undefined, mtime: number): Buffer[] {
  const records = [
    ...(fitsHeader(name) ? [] : [paxRecord('path', name)]),
    ...(linkName === undefined || fitsHeader(linkName) ? [] : [paxRecord('linkpath', linkName)]),
  ];
  if (records.length === 0) return [];
  const content = Buffer.from(records.join(''), 'utf8');
  return [
    header('PaxHeader', 'x', { size: content.length, mode: 0o644, mtime }),
    ...padded(content),
  ];
}

function entryBlocks(entry: TarEntry, mtime: number): Buffer[] {
  const name = entry.kind === 'directory' ? `${entry.path}/` : entry.path;
  const linkName = entry.kind === 'link' ? entry.target : undefined;
  // A pax header before it has what these stand in for.
  const shortName = fitsHeader(name) ? name : 'PaxPath';
  const blocks = paxHeader(name, linkName, mtime);
  if (entry.kind === 'directory') {
    blocks.push(header(shortName, '5', { mode: 0o755, mtime }));
  } else if (entry.kind === 'link') {
    const shortLink = fitsHeader(entry.target) ? entry.target : 'PaxLink';
    blocks.push(header(shortName, '2', { mode: 0o777, linkName: shortLink, mtime }));
  } else {
    const mode = entry.executable ? 0o755 : 0o644;
    blocks.push(header(shortName, '0', { size: entry.content.length, mode, mtime }));
    blocks.push(...padded(entry.content));
  }
  return blocks;
}

/**
 * A POSIX tar archive of the entries, in order, that GNU tar, bsdtar and BusyBox all extract. A
 * path or link target too long for a header, or not ASCII, goes in a pax header before its entry.
 * Entries carry no owner, and a file's mode only whether it is executable.
 */
export function tarArchive(entries: readonly TarEntry[], mtime = 0): Buffer {
  return Buffer.concat([
    ...entries.flatMap((entry) => entryBlocks(entry, mtime)),
    Buffer.alloc(BLOCK * 2),
  ]);
}
