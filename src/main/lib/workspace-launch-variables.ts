import {
  escapePowerShellDoubleQuoted,
  escapePowerShellSingleQuoted,
  isPowerShellDoubleQuote,
  isPowerShellSingleQuote,
  powerShellSingleQuote,
} from './powershell-native-arguments';
import { isWslMode, windowsPathToWsl } from './wsl';

export function substituteVariables(
  template: string,
  vars: Record<string, string>,
  options?: { shellEscape?: boolean; shellFamily?: 'desktop' | 'posix' }
): string {
  const escapeForShell = options?.shellEscape ?? false;
  const wsl = isWslMode();
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    // When in WSL mode, translate Windows paths to WSL mount paths so they
    // work inside the Linux environment (e.g. C:\project -> /mnt/c/project).
    const translated = wsl && /^[a-zA-Z]:[/\\]/.test(value) ? windowsPathToWsl(value) : value;
    if (escapeForShell) {
      const placeholder = `{{${key}}}`;
      let placeholderIndex = result.indexOf(placeholder);
      while (placeholderIndex !== -1) {
        const quoteContext = getShellQuoteContext(result, placeholderIndex, options?.shellFamily);
        const isCompleteQuotedToken =
          quoteContext !== undefined &&
          isQuote(result[placeholderIndex - 1], quoteContext, options?.shellFamily) &&
          isQuote(
            result[placeholderIndex + placeholder.length],
            quoteContext,
            options?.shellFamily
          );
        if (isCompleteQuotedToken) {
          const replacement = shellEscape(translated, options?.shellFamily);
          result =
            result.slice(0, placeholderIndex - 1) +
            replacement +
            result.slice(placeholderIndex + placeholder.length + 1);
          placeholderIndex = result.indexOf(placeholder, placeholderIndex - 1 + replacement.length);
          continue;
        }
        const replacement = quoteContext
          ? escapeForShellQuote(translated, quoteContext, options?.shellFamily)
          : shellEscape(translated, options?.shellFamily);
        result =
          result.slice(0, placeholderIndex) +
          replacement +
          result.slice(placeholderIndex + placeholder.length);
        placeholderIndex = result.indexOf(placeholder, placeholderIndex + replacement.length);
      }
      continue;
    }
    result = result.replaceAll(`{{${key}}}`, translated);
  }
  return result;
}

export function usesPowerShell(shellFamily: 'desktop' | 'posix' = 'desktop'): boolean {
  return shellFamily === 'desktop' && process.platform === 'win32' && !isWslMode();
}

function isQuote(
  character: string | undefined,
  quote: 'single' | 'double',
  shellFamily: 'desktop' | 'posix' = 'desktop'
): boolean {
  if (character === undefined) return false;
  if (usesPowerShell(shellFamily)) {
    return quote === 'single'
      ? isPowerShellSingleQuote(character)
      : isPowerShellDoubleQuote(character);
  }
  return character === (quote === 'single' ? "'" : '"');
}

function getShellQuoteContext(
  command: string,
  endIndex: number,
  shellFamily: 'desktop' | 'posix' = 'desktop'
): 'single' | 'double' | undefined {
  return usesPowerShell(shellFamily)
    ? getPowerShellQuoteContext(command, endIndex)
    : getPosixQuoteContext(command, endIndex);
}

function getPosixQuoteContext(command: string, endIndex: number): 'single' | 'double' | undefined {
  let quote: 'single' | 'double' | undefined;

  for (let index = 0; index < endIndex; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") {
        quote = undefined;
      }
      continue;
    }

    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = quote === 'double' ? undefined : 'double';
    } else if (character === "'" && quote !== 'double') {
      quote = 'single';
    }
  }

  return quote;
}

function getPowerShellQuoteContext(
  command: string,
  endIndex: number
): 'single' | 'double' | undefined {
  let quote: 'single' | 'double' | undefined;

  for (let index = 0; index < endIndex; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (isPowerShellSingleQuote(character) && isPowerShellSingleQuote(command[index + 1] ?? '')) {
        index += 1;
      } else if (isPowerShellSingleQuote(character)) {
        quote = undefined;
      }
      continue;
    }

    if (character === '`') {
      index += 1;
      continue;
    }
    if (isPowerShellDoubleQuote(character)) {
      quote = quote === 'double' ? undefined : 'double';
    } else if (isPowerShellSingleQuote(character) && quote !== 'double') {
      quote = 'single';
    }
  }

  return quote;
}

function escapeForShellQuote(
  value: string,
  quote: 'single' | 'double',
  shellFamily: 'desktop' | 'posix' = 'desktop'
): string {
  const normalized = value.replaceAll('\u0000', '').replace(/\r\n|\r|\n/g, ' ');
  if (usesPowerShell(shellFamily)) {
    return quote === 'single'
      ? escapePowerShellSingleQuoted(normalized)
      : escapePowerShellDoubleQuoted(normalized);
  }
  return quote === 'single'
    ? normalized.replaceAll("'", `'"'"'`)
    : normalized.replace(/[\\$"`]/g, '\\$&');
}

export function shellEscape(value: string, shellFamily: 'desktop' | 'posix' = 'desktop'): string {
  // Strip null bytes which no shell handles safely.
  // Use /\r\n|\r|\n/ to also catch standalone \r (which \r?\n misses).
  const normalized = value.replaceAll('\u0000', '').replace(/\r\n|\r|\n/g, ' ');
  if (usesPowerShell(shellFamily)) {
    // The PTY shell on Windows is PowerShell (pwsh or powershell.exe, see getShell()).
    return powerShellSingleQuote(normalized);
  }

  // POSIX shell single-quoted string (Unix or WSL): wrap in single quotes and
  // escape any embedded single quotes using the '"'"' idiom.
  return `'${normalized.replace(/'/g, `'"'"'`)}'`;
}
