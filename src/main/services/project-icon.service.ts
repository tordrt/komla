import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, extname, join } from 'path';
import { promisify } from 'util';

import { dialog, nativeImage, type BrowserWindow } from 'electron';

import { MAX_PROJECT_ICON_BYTES } from '../../shared/lib/project-icon';
import { isSshWorkspace } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';

import { buildGitEnv } from './git/git-exec';
import { workspaceFileService } from './workspace-file.service';

import type { ProjectIconCandidate, Workspace } from '../../shared/types';

const execFileAsync = promisify(execFile);
const logger = createLogger('ProjectIcons');

const MAX_CANDIDATES = 6;
/** Images read before giving up on filling MAX_CANDIDATES, since some won't decode. */
const MAX_READS = 24;
/** Raster images up to this size are read to be scaled down. */
const MAX_RASTER_READ_BYTES = 2 * 1024 * 1024;
/** Raster icons are scaled down to fit this many pixels a side. */
const ICON_PIXELS = 64;
/** A folder outside Git is walked this deep, for at most WALK_LIMIT entries. */
const WALK_DEPTH = 4;
const WALK_LIMIT = 5000;

const MIME_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
};
// SVG scales cleanly, ICO is often far larger than the size shown.
const EXTENSION_RANK: Record<string, number> = { svg: 0, png: 1, jpg: 1, jpeg: 1, ico: 2 };

// App icons of one folder are usually the same artwork in several sizes, so one stands for all.
const APP_ICON_NAME =
  /^(?:favicon(?:[-_.][\w.-]*)?|apple-touch-icon(?:[-_.][\w.-]*)?|apple-icon|android-chrome-[\w.-]+|(?:app[-_]?)?icon(?:[-_@]\d+(?:x\d+)?)?(?:@\dx)?)$/;
// Logo variants such as logo-dark or logo-full differ, so each is offered.
const LOGO_NAME = /^logo(?:[-_.@][\w.-]*)?$/;
const SIZE_SUFFIX = /(?:[-_]\d+(?:x\d+)?|@\dx)+$/;

// Folders holding other projects' images: dependencies, fixtures, examples, linked workspaces
// and files dropped into a workspace.
const SKIPPED_FOLDERS = new Set([
  'linked-workspaces',
  '.komla-files',
  'node_modules',
  'bower_components',
  'vendor',
  'third_party',
  'third-party',
  'pods',
  'fixtures',
  '__fixtures__',
  'test',
  'tests',
  '__tests__',
  'e2e',
  'example',
  'examples',
  'sample',
  'samples',
]);
// Folders where a project keeps its own icons.
const ICON_FOLDERS = new Set([
  'public',
  'static',
  'app',
  'assets',
  'build',
  'resources',
  'images',
  'img',
  'icons',
  'media',
  'brand',
  'branding',
  'docs',
  '.github',
]);

interface IconFile {
  path: string;
  extension: string;
  /** Files of a family are one icon; the best of them that loads is offered. */
  family: string;
  rank: number;
  rankInFamily: number;
}

/**
 * Finds images in a folder that could be its project's icon, best first: favicons and app
 * icons, then logos, nearest the top and in the folders such files usually live in.
 */
export async function scanProjectIcons(folder: string): Promise<ProjectIconCandidate[]> {
  return scanIconFiles(await listFiles(folder), (path, extension) =>
    loadIcon(join(folder, path), extension)
  );
}

/** The icons in a workspace's files, read over SSH when it runs on a host. */
export async function scanWorkspaceIcons(workspace: Workspace): Promise<ProjectIconCandidate[]> {
  if (!isSshWorkspace(workspace)) return scanProjectIcons(workspace.workingDirectory);
  let paths: string[];
  try {
    paths = await workspaceFileService.listRemoteGitFiles(workspace.id);
  } catch (error) {
    logger.debug('Could not list an SSH workspace for project icons', { error });
    return [];
  }
  // Only the files that could be icons are read, within the limit of their format.
  return scanIconFiles(paths, async (path, extension) => {
    try {
      const bytes = await workspaceFileService.readRemoteFileBytes(
        workspace.id,
        path,
        iconReadLimit(extension)
      );
      return bytes.length === 0 ? { failure: 'unreadable' } : decodeIcon(bytes, extension);
    } catch (error) {
      logger.debug('Could not read a project icon candidate', { path, error });
      return { failure: 'unreadable' };
    }
  });
}

async function scanIconFiles(
  paths: string[],
  load: (path: string, extension: string) => Promise<LoadedIcon>
): Promise<ProjectIconCandidate[]> {
  const families = new Map<string, IconFile[]>();
  for (const file of rankIconFiles(paths)) {
    const family = families.get(file.family);
    if (family) family.push(file);
    else families.set(file.family, [file]);
  }
  let reads = 0;
  // A family offers its best file that loads.
  const loadFamily = async (files: IconFile[]): Promise<ProjectIconCandidate | null> => {
    for (const file of files) {
      if (reads >= MAX_READS) return null;
      reads++;
      const loaded = await load(file.path, file.extension);
      if ('dataUrl' in loaded) return { path: file.path, dataUrl: loaded.dataUrl };
    }
    return null;
  };

  const pending = [...families.values()];
  const candidates: ProjectIconCandidate[] = [];
  const contents = new Set<string>();
  // The best families still needed are read at once, so an SSH host answers them together.
  while (candidates.length < MAX_CANDIDATES && pending.length > 0 && reads < MAX_READS) {
    const batch = pending.splice(0, MAX_CANDIDATES - candidates.length);
    for (const icon of await Promise.all(batch.map(loadFamily))) {
      if (!icon) continue;
      // Copies of one image, such as a favicon in public/ and in docs/, are offered once.
      const hash = createHash('sha1').update(icon.dataUrl).digest('hex');
      if (contents.has(hash)) continue;
      contents.add(hash);
      candidates.push(icon);
    }
  }
  return candidates;
}

/** Asks for an image to use as a project's icon, from anywhere on disk; null when cancelled. */
export async function chooseProjectIconFile(
  window: BrowserWindow | null
): Promise<ProjectIconCandidate | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose Project Icon',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: Object.keys(MIME_TYPES) }],
  };
  const result = await (window
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options));
  const file = result.filePaths[0];
  if (result.canceled || !file) return null;
  const name = basename(file);
  const extension = extname(file).slice(1).toLowerCase();
  if (!(extension in MIME_TYPES)) throw new Error('Choose an SVG, PNG, JPEG or ICO image.');
  const loaded = await loadIcon(file, extension);
  if ('dataUrl' in loaded) return { path: name, dataUrl: loaded.dataUrl };
  if (loaded.failure === 'unreadable') throw new Error(`Couldn't read ${name} as an image.`);
  throw new Error(
    isRaster(extension)
      ? `${name} is over ${MAX_RASTER_READ_BYTES / 1024 / 1024} MB. Choose a smaller image.`
      : `${name} is over ${MAX_PROJECT_ICON_BYTES / 1024} KB. Choose a smaller SVG or ICO, or a PNG or JPEG.`
  );
}

/** The icon-like files among a folder's relative paths, best first. Exported for tests. */
export function rankIconFiles(paths: string[]): IconFile[] {
  const files: IconFile[] = [];
  for (const path of paths) {
    const segments = path.split('/');
    const fileName = segments.pop()!.toLowerCase();
    const folders = segments.map((segment) => segment.toLowerCase());
    if (folders.some((folder) => SKIPPED_FOLDERS.has(folder))) continue;
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) continue;
    const extension = fileName.slice(dot + 1);
    if (!(extension in MIME_TYPES)) continue;
    const stem = fileName.slice(0, dot);
    const isAppIcon = APP_ICON_NAME.test(stem);
    if (!isAppIcon && !LOGO_NAME.test(stem)) continue;

    const folderPath = folders.join('/');
    const knownFolder = folders.length === 0 || folders.some((folder) => ICON_FOLDERS.has(folder));
    const pixels = Number(/(\d+)(?:x\d+)?(?:@\dx)?$/.exec(stem)?.[1] ?? 0);
    files.push({
      path,
      extension,
      family: isAppIcon
        ? `${folderPath}/app-icon`
        : `${folderPath}/${stem.replace(SIZE_SUFFIX, '')}`,
      rank: (isAppIcon ? 0 : 100) + folders.length * 10 + (knownFolder ? 0 : 5),
      // Larger rasters scale down to the size shown better than small ones scale up.
      rankInFamily: EXTENSION_RANK[extension] * 10_000 - Math.min(pixels, 9_999),
    });
  }
  return files.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.family.localeCompare(b.family) ||
      a.rankInFamily - b.rankInFamily ||
      a.path.localeCompare(b.path)
  );
}

// Git lists a repository's own files, untracked ones included, without ignored builds. A
// folder an enclosing repository ignores, such as one under a dotfiles repo, lists nothing.
async function listFiles(folder: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: folder, env: buildGitEnv(), encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
    );
    const files = stdout.split('\0').filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // Not in a repository.
  }
  return walk(folder);
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  let entries = 0;
  const visit = async (relativeFolder: string, depth: number): Promise<void> => {
    let children;
    try {
      children = await readdir(join(root, relativeFolder), { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (++entries > WALK_LIMIT) return;
      const path = relativeFolder ? `${relativeFolder}/${child.name}` : child.name;
      if (child.isFile()) {
        files.push(path);
      } else if (
        child.isDirectory() &&
        depth < WALK_DEPTH &&
        (!child.name.startsWith('.') || child.name === '.github') &&
        !SKIPPED_FOLDERS.has(child.name.toLowerCase())
      ) {
        await visit(path, depth + 1);
      }
    }
  };
  await visit('', 1);
  return files;
}

function isRaster(extension: string): boolean {
  return extension === 'png' || extension === 'jpg' || extension === 'jpeg';
}

type LoadedIcon = { dataUrl: string } | { failure: 'too-large' | 'unreadable' };

/** Raster images are read up to a larger size than they're stored at, to be scaled down. */
function iconReadLimit(extension: string): number {
  return isRaster(extension) ? MAX_RASTER_READ_BYTES : MAX_PROJECT_ICON_BYTES;
}

async function loadIcon(path: string, extension: string): Promise<LoadedIcon> {
  try {
    const { size } = await stat(path);
    if (size === 0) return { failure: 'unreadable' };
    if (size > iconReadLimit(extension)) return { failure: 'too-large' };
    return decodeIcon(await readFile(path), extension);
  } catch (error) {
    logger.debug('Could not read a project icon candidate', { path, error });
    return { failure: 'unreadable' };
  }
}

function decodeIcon(bytes: Buffer, extension: string): LoadedIcon {
  let mimeType = MIME_TYPES[extension];
  if (isRaster(extension)) {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return { failure: 'unreadable' };
    const { width, height } = image.getSize();
    // Re-encoding drops the metadata that can make even a small image too large to store.
    if (Math.max(width, height) > ICON_PIXELS || bytes.length > MAX_PROJECT_ICON_BYTES) {
      const scaled =
        Math.max(width, height) > ICON_PIXELS
          ? image.resize(width >= height ? { width: ICON_PIXELS } : { height: ICON_PIXELS })
          : image;
      bytes = scaled.toPNG();
      mimeType = MIME_TYPES.png;
    }
  }
  if (bytes.length > MAX_PROJECT_ICON_BYTES) return { failure: 'too-large' };
  return { dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` };
}
