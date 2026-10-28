import {
  FileText,
  FileTs,
  FileTsx,
  FileJs,
  FileJsx,
  FilePy,
  FileRs,
  FileC,
  FileCpp,
  FileCSharp,
  FileHtml,
  FileVue,
  FileCss,
  FileMd,
  FileSql,
  FileSvg,
  FilePng,
  FileJpg,
  FileImage,
  FileVideo,
  FileAudio,
  FileZip,
  FilePdf,
  FileDoc,
  FileXls,
  FileCsv,
  FileCode,
  FileIni,
  FileLock,
  BracketsCurly,
  Terminal,
  Package,
  GearSix,
  type IconProps,
} from '@phosphor-icons/react';
import { memo, type ComponentType } from 'react';

import { cn } from '@/lib/utils';

interface FileIconInfo {
  icon: ComponentType<IconProps>;
  colorClass: string;
}

const EXACT_NAME_MAP: Record<string, FileIconInfo> = {
  Dockerfile: { icon: FileCode, colorClass: 'text-sky-500' },
  Makefile: { icon: Terminal, colorClass: 'text-muted-foreground' },
  'package.json': { icon: Package, colorClass: 'text-green-600 dark:text-green-500' },
  'tsconfig.json': { icon: GearSix, colorClass: 'text-blue-500' },
  '.gitignore': { icon: GearSix, colorClass: 'text-muted-foreground' },
  '.gitattributes': { icon: GearSix, colorClass: 'text-muted-foreground' },
  '.gitmodules': { icon: GearSix, colorClass: 'text-muted-foreground' },
  '.editorconfig': { icon: GearSix, colorClass: 'text-muted-foreground' },
  '.prettierrc': { icon: GearSix, colorClass: 'text-muted-foreground' },
  '.eslintrc': { icon: GearSix, colorClass: 'text-muted-foreground' },
};

const EXT_MAP: Record<string, FileIconInfo> = {
  '.ts': { icon: FileTs, colorClass: 'text-blue-500' },
  '.tsx': { icon: FileTsx, colorClass: 'text-blue-500' },
  '.js': { icon: FileJs, colorClass: 'text-yellow-500' },
  '.mjs': { icon: FileJs, colorClass: 'text-yellow-500' },
  '.cjs': { icon: FileJs, colorClass: 'text-yellow-500' },
  '.jsx': { icon: FileJsx, colorClass: 'text-yellow-500' },
  '.py': { icon: FilePy, colorClass: 'text-blue-400' },
  '.pyw': { icon: FilePy, colorClass: 'text-blue-400' },
  '.rs': { icon: FileRs, colorClass: 'text-orange-600 dark:text-orange-400' },
  '.c': { icon: FileC, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.h': { icon: FileC, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.cpp': { icon: FileCpp, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.cxx': { icon: FileCpp, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.cc': { icon: FileCpp, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.hpp': { icon: FileCpp, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.hxx': { icon: FileCpp, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.cs': { icon: FileCSharp, colorClass: 'text-purple-500' },
  '.html': { icon: FileHtml, colorClass: 'text-orange-500' },
  '.htm': { icon: FileHtml, colorClass: 'text-orange-500' },
  '.vue': { icon: FileVue, colorClass: 'text-green-500' },
  '.svelte': { icon: FileCode, colorClass: 'text-orange-500' },
  '.css': { icon: FileCss, colorClass: 'text-blue-500' },
  '.scss': { icon: FileCss, colorClass: 'text-pink-500' },
  '.sass': { icon: FileCss, colorClass: 'text-pink-500' },
  '.less': { icon: FileCss, colorClass: 'text-pink-500' },
  '.json': { icon: BracketsCurly, colorClass: 'text-yellow-600 dark:text-yellow-400' },
  '.jsonc': { icon: BracketsCurly, colorClass: 'text-yellow-600 dark:text-yellow-400' },
  '.md': { icon: FileMd, colorClass: 'text-muted-foreground' },
  '.mdx': { icon: FileMd, colorClass: 'text-muted-foreground' },
  '.yaml': { icon: FileIni, colorClass: 'text-pink-500' },
  '.yml': { icon: FileIni, colorClass: 'text-pink-500' },
  '.toml': { icon: FileIni, colorClass: 'text-muted-foreground' },
  '.ini': { icon: FileIni, colorClass: 'text-muted-foreground' },
  '.sql': { icon: FileSql, colorClass: 'text-yellow-600 dark:text-yellow-400' },
  '.psql': { icon: FileSql, colorClass: 'text-yellow-600 dark:text-yellow-400' },
  '.svg': { icon: FileSvg, colorClass: 'text-amber-500' },
  '.png': { icon: FilePng, colorClass: 'text-green-500' },
  '.jpg': { icon: FileJpg, colorClass: 'text-green-500' },
  '.jpeg': { icon: FileJpg, colorClass: 'text-green-500' },
  '.gif': { icon: FileImage, colorClass: 'text-green-500' },
  '.webp': { icon: FileImage, colorClass: 'text-green-500' },
  '.ico': { icon: FileImage, colorClass: 'text-green-500' },
  '.bmp': { icon: FileImage, colorClass: 'text-green-500' },
  '.mp4': { icon: FileVideo, colorClass: 'text-purple-500' },
  '.mov': { icon: FileVideo, colorClass: 'text-purple-500' },
  '.avi': { icon: FileVideo, colorClass: 'text-purple-500' },
  '.mkv': { icon: FileVideo, colorClass: 'text-purple-500' },
  '.webm': { icon: FileVideo, colorClass: 'text-purple-500' },
  '.mp3': { icon: FileAudio, colorClass: 'text-purple-500' },
  '.wav': { icon: FileAudio, colorClass: 'text-purple-500' },
  '.ogg': { icon: FileAudio, colorClass: 'text-purple-500' },
  '.flac': { icon: FileAudio, colorClass: 'text-purple-500' },
  '.zip': { icon: FileZip, colorClass: 'text-amber-600 dark:text-amber-400' },
  '.tar': { icon: FileZip, colorClass: 'text-amber-600 dark:text-amber-400' },
  '.gz': { icon: FileZip, colorClass: 'text-amber-600 dark:text-amber-400' },
  '.bz2': { icon: FileZip, colorClass: 'text-amber-600 dark:text-amber-400' },
  '.7z': { icon: FileZip, colorClass: 'text-amber-600 dark:text-amber-400' },
  '.rar': { icon: FileZip, colorClass: 'text-amber-600 dark:text-amber-400' },
  '.pdf': { icon: FilePdf, colorClass: 'text-red-500' },
  '.doc': { icon: FileDoc, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.docx': { icon: FileDoc, colorClass: 'text-blue-600 dark:text-blue-400' },
  '.xls': { icon: FileXls, colorClass: 'text-green-600 dark:text-green-500' },
  '.xlsx': { icon: FileXls, colorClass: 'text-green-600 dark:text-green-500' },
  '.csv': { icon: FileCsv, colorClass: 'text-green-600 dark:text-green-500' },
  '.sh': { icon: Terminal, colorClass: 'text-muted-foreground' },
  '.bash': { icon: Terminal, colorClass: 'text-muted-foreground' },
  '.zsh': { icon: Terminal, colorClass: 'text-muted-foreground' },
  '.fish': { icon: Terminal, colorClass: 'text-muted-foreground' },
  '.go': { icon: FileCode, colorClass: 'text-cyan-500' },
  '.rb': { icon: FileCode, colorClass: 'text-red-500' },
  '.java': { icon: FileCode, colorClass: 'text-orange-500' },
  '.kt': { icon: FileCode, colorClass: 'text-orange-500' },
  '.kts': { icon: FileCode, colorClass: 'text-orange-500' },
  '.scala': { icon: FileCode, colorClass: 'text-orange-500' },
  '.swift': { icon: FileCode, colorClass: 'text-orange-500' },
  '.dart': { icon: FileCode, colorClass: 'text-sky-500' },
  '.ex': { icon: FileCode, colorClass: 'text-purple-500' },
  '.exs': { icon: FileCode, colorClass: 'text-purple-500' },
  '.lua': { icon: FileCode, colorClass: 'text-blue-500' },
  '.php': { icon: FileCode, colorClass: 'text-indigo-500' },
  '.tf': { icon: FileCode, colorClass: 'text-purple-500' },
  '.hcl': { icon: FileCode, colorClass: 'text-purple-500' },
  '.graphql': { icon: FileCode, colorClass: 'text-pink-500' },
  '.gql': { icon: FileCode, colorClass: 'text-pink-500' },
  '.lock': { icon: FileLock, colorClass: 'text-muted-foreground' },
  '.xml': { icon: FileCode, colorClass: 'text-orange-500' },
  '.xsl': { icon: FileCode, colorClass: 'text-orange-500' },
  '.xsd': { icon: FileCode, colorClass: 'text-orange-500' },
};

const FALLBACK: FileIconInfo = { icon: FileText, colorClass: 'text-muted-foreground' };
const ENV_ICON: FileIconInfo = {
  icon: FileLock,
  colorClass: 'text-yellow-600 dark:text-yellow-400',
};

export function getFileIcon(fileName: string): FileIconInfo {
  // Exact name match (use base name only)
  const baseName = fileName.includes('/')
    ? fileName.slice(fileName.lastIndexOf('/') + 1)
    : fileName;
  const exact = EXACT_NAME_MAP[baseName];
  if (exact) return exact;

  // .env* prefix match
  if (baseName.startsWith('.env')) return ENV_ICON;

  // Extension match
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex > 0) {
    const ext = baseName.slice(dotIndex).toLowerCase();
    const byExt = EXT_MAP[ext];
    if (byExt) return byExt;
  }

  return FALLBACK;
}

export const FileTypeIcon = memo(function FileTypeIcon({
  fileName,
  className,
}: {
  fileName: string;
  className?: string;
}) {
  const { icon: Icon, colorClass } = getFileIcon(fileName);
  return <Icon className={cn(className, colorClass)} />;
});
