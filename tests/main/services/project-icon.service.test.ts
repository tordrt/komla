import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chooseProjectIconFile,
  rankIconFiles,
  scanProjectIcons,
  scanWorkspaceIcons,
} from '../../../src/main/services/project-icon.service';
import { MAX_PROJECT_ICON_BYTES } from '../../../src/shared/lib/project-icon';

import type { Workspace } from '../../../src/shared/types';

const { showOpenDialog, listRemoteGitFiles, readRemoteFileBytes } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  listRemoteGitFiles: vi.fn(),
  readRemoteFileBytes: vi.fn(),
}));

vi.mock('../../../src/main/services/workspace-file.service', () => ({
  workspaceFileService: { listRemoteGitFiles, readRemoteFileBytes },
}));

// Decoded rasters report the size written into their first two bytes, and scale to a marker.
vi.mock('electron', async () => {
  const { mockElectron } = await import('../../mocks/electron');
  return mockElectron({
    dialog: { showOpenDialog },
    nativeImage: {
      createFromBuffer: (buffer: Buffer) => ({
        isEmpty: () => buffer.length < 2,
        getSize: () => ({ width: buffer[0], height: buffer[1] }),
        toPNG: () => Buffer.from('reencoded'),
        resize: (size: { width?: number; height?: number }) => ({
          toPNG: () => Buffer.from(`scaled-${size.width ?? 'auto'}x${size.height ?? 'auto'}`),
        }),
      }),
    },
  });
});

const dataUrl = (mimeType: string, bytes: string | Buffer) =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;

describe('rankIconFiles', () => {
  const rank = (paths: string[]) => rankIconFiles(paths).map((file) => file.path);

  it('keeps only favicons, app icons and logos in formats an <img> shows', () => {
    expect(
      rank([
        'README.md',
        'src/index.ts',
        'favicon.ico',
        'public/icon-192x192.png',
        'assets/logo-dark.svg',
        'logo.webp',
        'build/icon.icns',
        'src/icons/icon-arrow.svg',
        'images/background.png',
      ]).sort()
    ).toEqual(['assets/logo-dark.svg', 'favicon.ico', 'public/icon-192x192.png']);
  });

  it("skips other projects' images: dependencies, fixtures and examples", () => {
    expect(
      rank([
        'linked-workspaces/other/favicon.ico',
        '.komla-files/logo.svg',
        'node_modules/pkg/favicon.ico',
        'vendor/lib/logo.svg',
        'tests/fixtures/favicon.svg',
        'examples/blog/public/favicon.ico',
        'Pods/Thing/icon.png',
      ])
    ).toEqual([]);
  });

  it('puts app icons before logos, then shallower files and icon folders first', () => {
    expect(
      rank([
        'logo.svg',
        'packages/web/src/favicon.svg',
        'apps/web/public/favicon.svg',
        'public/favicon.svg',
        'favicon.ico',
      ])
    ).toEqual([
      'favicon.ico',
      'public/favicon.svg',
      'apps/web/public/favicon.svg',
      'packages/web/src/favicon.svg',
      'logo.svg',
    ]);
  });

  it('offers one app icon per folder, preferring SVG, then the largest raster', () => {
    const files = rankIconFiles([
      'public/favicon.ico',
      'public/favicon-16x16.png',
      'public/android-chrome-512x512.png',
      'public/apple-touch-icon.png',
    ]);
    expect(new Set(files.map((file) => file.family)).size).toBe(1);
    expect(files.map((file) => file.path)).toEqual([
      'public/android-chrome-512x512.png',
      'public/favicon-16x16.png',
      'public/apple-touch-icon.png',
      'public/favicon.ico',
    ]);
    expect(rankIconFiles(['public/favicon.ico', 'public/icon.svg'])[0].path).toBe(
      'public/icon.svg'
    );
  });

  it('offers each logo variant, but one per size', () => {
    const families = rankIconFiles([
      'assets/logo.svg',
      'assets/logo-dark.svg',
      'assets/logo@2x.png',
      'assets/logo-64.png',
    ]).map((file) => file.family);
    expect(new Set(families)).toEqual(new Set(['assets/logo', 'assets/logo-dark']));
  });
});

describe('scanProjectIcons', () => {
  let folder: string;

  const write = (path: string, contents: string | Buffer) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), contents);
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'komla-project-icons-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('finds nothing in a folder without icons', async () => {
    write('README.md', '# Hello');
    await expect(scanProjectIcons(folder)).resolves.toEqual([]);
  });

  it('reads SVG and ICO files as they are, best first', async () => {
    write('assets/logo.svg', '<svg/>');
    write('favicon.ico', 'ico-bytes');

    await expect(scanProjectIcons(folder)).resolves.toEqual([
      { path: 'favicon.ico', dataUrl: dataUrl('image/x-icon', 'ico-bytes') },
      { path: 'assets/logo.svg', dataUrl: dataUrl('image/svg+xml', '<svg/>') },
    ]);
  });

  it('scales rasters larger than an icon down to fit 64 pixels', async () => {
    write('public/apple-touch-icon.png', Buffer.from([180, 180]));
    write('assets/logo.png', Buffer.from([40, 200]));
    write('static/logo.jpg', Buffer.from([32, 32]));

    const icons = await scanProjectIcons(folder);
    expect(icons).toEqual([
      { path: 'public/apple-touch-icon.png', dataUrl: dataUrl('image/png', 'scaled-64xauto') },
      { path: 'assets/logo.png', dataUrl: dataUrl('image/png', 'scaled-autox64') },
      { path: 'static/logo.jpg', dataUrl: dataUrl('image/jpeg', Buffer.from([32, 32])) },
    ]);
  });

  it('falls back to the next file of an icon that fails to load', async () => {
    write('public/favicon.svg', '');
    write('public/favicon.png', Buffer.from([1]));
    write('public/favicon.ico', 'ico-bytes');

    await expect(scanProjectIcons(folder)).resolves.toEqual([
      { path: 'public/favicon.ico', dataUrl: dataUrl('image/x-icon', 'ico-bytes') },
    ]);
  });

  it('skips files too large to store and offers copies of one image once', async () => {
    write('logo.svg', 'x'.repeat(MAX_PROJECT_ICON_BYTES + 1));
    write('public/favicon.ico', 'same');
    write('docs/favicon.ico', 'same');

    await expect(scanProjectIcons(folder)).resolves.toEqual([
      { path: 'docs/favicon.ico', dataUrl: dataUrl('image/x-icon', 'same') },
    ]);
  });

  it("lists a Git repository's own files, leaving out ignored ones", async () => {
    execFileSync('git', ['init', '-q'], { cwd: folder });
    write('.gitignore', 'dist/\n');
    write('dist/favicon.ico', 'built');
    write('src/logo.svg', '<svg/>');

    await expect(scanProjectIcons(folder)).resolves.toEqual([
      { path: 'src/logo.svg', dataUrl: dataUrl('image/svg+xml', '<svg/>') },
    ]);
  });

  it('walks a folder that an enclosing repository ignores', async () => {
    execFileSync('git', ['init', '-q'], { cwd: folder });
    write('.gitignore', '*\n');
    write('app/public/favicon.ico', 'ico');

    await expect(scanProjectIcons(join(folder, 'app'))).resolves.toEqual([
      { path: 'public/favicon.ico', dataUrl: dataUrl('image/x-icon', 'ico') },
    ]);
  });

  it('walks a folder outside Git, skipping hidden folders but .github', async () => {
    write('.cache/favicon.ico', 'cached');
    write('.github/logo.svg', '<svg/>');

    await expect(scanProjectIcons(folder)).resolves.toEqual([
      { path: '.github/logo.svg', dataUrl: dataUrl('image/svg+xml', '<svg/>') },
    ]);
  });
});

describe('scanWorkspaceIcons', () => {
  const sshWorkspace = {
    id: 'w1',
    workingDirectory: '/remote/w1',
    backend: { kind: 'ssh', hostId: 'h1' },
  } as unknown as Workspace;

  beforeEach(() => {
    listRemoteGitFiles.mockReset();
    readRemoteFileBytes.mockReset();
  });

  it("scans a local workspace's folder", async () => {
    const folder = mkdtempSync(join(tmpdir(), 'komla-project-icons-'));
    try {
      writeFileSync(join(folder, 'favicon.ico'), 'ico');
      await expect(
        scanWorkspaceIcons({ id: 'w1', workingDirectory: folder } as Workspace)
      ).resolves.toEqual([{ path: 'favicon.ico', dataUrl: dataUrl('image/x-icon', 'ico') }]);
      expect(listRemoteGitFiles).not.toHaveBeenCalled();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("reads only the icon files of an SSH workspace, within each format's limit", async () => {
    listRemoteGitFiles.mockResolvedValue([
      'README.md',
      'logo.svg',
      'public/favicon.png',
      'src/index.ts',
    ]);
    const remote: Record<string, Buffer> = {
      'public/favicon.png': Buffer.from([128, 64]),
      'logo.svg': Buffer.from('<svg/>'),
    };
    readRemoteFileBytes.mockImplementation(async (_id: string, path: string) => remote[path]);

    await expect(scanWorkspaceIcons(sshWorkspace)).resolves.toEqual([
      { path: 'public/favicon.png', dataUrl: dataUrl('image/png', 'scaled-64xauto') },
      { path: 'logo.svg', dataUrl: dataUrl('image/svg+xml', '<svg/>') },
    ]);
    expect(readRemoteFileBytes.mock.calls).toEqual([
      ['w1', 'public/favicon.png', 2 * 1024 * 1024],
      ['w1', 'logo.svg', MAX_PROJECT_ICON_BYTES],
    ]);
  });

  it("falls back to the next file of an icon it can't read", async () => {
    listRemoteGitFiles.mockResolvedValue(['favicon.svg', 'favicon.ico', 'assets/logo.svg']);
    readRemoteFileBytes.mockImplementation(async (_id: string, path: string) => {
      if (path === 'favicon.svg') throw new Error('Remote file is too large to view');
      if (path === 'assets/logo.svg') return Buffer.alloc(0);
      return Buffer.from(path);
    });

    await expect(scanWorkspaceIcons(sshWorkspace)).resolves.toEqual([
      { path: 'favicon.ico', dataUrl: dataUrl('image/x-icon', 'favicon.ico') },
    ]);
    expect(readRemoteFileBytes.mock.calls.map(([, path]) => path)).toEqual([
      'favicon.svg',
      'assets/logo.svg',
      'favicon.ico',
    ]);
  });

  it('reads the best file of each icon at once, not one after another', async () => {
    listRemoteGitFiles.mockResolvedValue(['favicon.ico', 'logo.svg', 'docs/logo.svg']);
    const pending: Array<() => void> = [];
    readRemoteFileBytes.mockImplementation(
      (_id: string, path: string) =>
        new Promise<Buffer>((resolve) => pending.push(() => resolve(Buffer.from(path))))
    );

    const scan = scanWorkspaceIcons(sshWorkspace);
    await vi.waitFor(() => expect(readRemoteFileBytes).toHaveBeenCalledTimes(3));
    for (const answer of pending) answer();

    await expect(scan).resolves.toEqual([
      { path: 'favicon.ico', dataUrl: dataUrl('image/x-icon', 'favicon.ico') },
      { path: 'logo.svg', dataUrl: dataUrl('image/svg+xml', 'logo.svg') },
      { path: 'docs/logo.svg', dataUrl: dataUrl('image/svg+xml', 'docs/logo.svg') },
    ]);
  });

  it('finds nothing when the host does not answer', async () => {
    listRemoteGitFiles.mockRejectedValue(new Error('ssh: connect to host timed out'));
    await expect(scanWorkspaceIcons(sshWorkspace)).resolves.toEqual([]);
  });
});

describe('chooseProjectIconFile', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'komla-project-icon-upload-'));
    showOpenDialog.mockReset();
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const pick = (name: string, contents: string | Buffer) => {
    writeFileSync(join(folder, name), contents);
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [join(folder, name)] });
  };

  it('reads an image from anywhere, named after its file', async () => {
    pick('Brand Mark.SVG', '<svg/>');

    await expect(chooseProjectIconFile(null)).resolves.toEqual({
      path: 'Brand Mark.SVG',
      dataUrl: dataUrl('image/svg+xml', '<svg/>'),
    });
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'ico'] }],
      })
    );
  });

  it('scales an uploaded raster down like a found one', async () => {
    pick('logo.png', Buffer.from([200, 100]));

    await expect(chooseProjectIconFile(null)).resolves.toEqual({
      path: 'logo.png',
      dataUrl: dataUrl('image/png', 'scaled-64xauto'),
    });
  });

  it('returns nothing when cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(chooseProjectIconFile(null)).resolves.toBeNull();
  });

  it('re-encodes a small raster too large to store as it is', async () => {
    pick('small.png', Buffer.concat([Buffer.from([32, 32]), Buffer.alloc(MAX_PROJECT_ICON_BYTES)]));

    await expect(chooseProjectIconFile(null)).resolves.toEqual({
      path: 'small.png',
      dataUrl: dataUrl('image/png', 'reencoded'),
    });
  });

  it('says what is wrong with a file it cannot use', async () => {
    pick('huge.svg', 'x'.repeat(MAX_PROJECT_ICON_BYTES + 1));
    await expect(chooseProjectIconFile(null)).rejects.toThrow(
      'huge.svg is over 48 KB. Choose a smaller SVG or ICO, or a PNG or JPEG.'
    );

    pick('huge.png', Buffer.alloc(2 * 1024 * 1024 + 1, 200));
    await expect(chooseProjectIconFile(null)).rejects.toThrow(
      'huge.png is over 2 MB. Choose a smaller image.'
    );

    pick('broken.png', Buffer.from([1]));
    await expect(chooseProjectIconFile(null)).rejects.toThrow(
      "Couldn't read broken.png as an image."
    );

    pick('photo.webp', 'webp');
    await expect(chooseProjectIconFile(null)).rejects.toThrow(
      'Choose an SVG, PNG, JPEG or ICO image.'
    );
  });
});
