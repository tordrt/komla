import { Check } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

import { SettingsCard } from './SettingsCard';

const TRASH_CLEANUP_PRESETS: ReadonlyArray<{ label: string; paths: readonly string[] }> = [
  { label: 'Node', paths: ['node_modules', '.next', '.nuxt', 'dist', 'build', '.turbo', '.vite'] },
  {
    label: 'Python',
    paths: ['.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'],
  },
  { label: 'Rust', paths: ['target'] },
  { label: 'Gradle', paths: ['build', '.gradle'] },
  { label: '.NET', paths: ['bin', 'obj'] },
];

// Mirror of parseSimpleRmRfScript in src/main/ipc/handlers/workspace.handlers.ts —
// keep them in sync so preset chips reflect what the backend treats as the
// portable native fast-path.
const RM_RF_PATTERN = /^\s*rm\s+-(?:rf|fr)\s+(.+?)\s*$/;
const SAFE_PATH_TOKEN = /^[A-Za-z0-9._\-/]+$/;

function parseRmRfPaths(script: string): string[] {
  const match = RM_RF_PATTERN.exec(script);
  if (!match) return [];
  const paths = match[1].split(/\s+/).filter(Boolean);
  if (paths.length === 0) return [];
  for (const p of paths) {
    if (
      p === '.' ||
      p.startsWith('-') ||
      p.startsWith('/') ||
      !SAFE_PATH_TOKEN.test(p) ||
      p.split('/').includes('..')
    ) {
      return [];
    }
  }
  return paths;
}

function buildRmRfScript(paths: readonly string[]): string {
  return paths.length === 0 ? '' : `rm -rf ${paths.join(' ')}`;
}

interface TrashCleanupCardProps {
  script: string;
  onScriptChange: (script: string) => void;
}

export function TrashCleanupCard({ script, onScriptChange }: TrashCleanupCardProps) {
  const currentPaths = parseRmRfPaths(script);
  const isCustomScript = script.trim() !== '' && currentPaths.length === 0;

  const togglePreset = (preset: (typeof TRASH_CLEANUP_PRESETS)[number]) => {
    if (isCustomScript) return; // Don't clobber a custom script
    const allActive = preset.paths.every((p) => currentPaths.includes(p));
    const next = allActive
      ? currentPaths.filter((p) => !preset.paths.includes(p))
      : Array.from(new Set([...currentPaths, ...preset.paths]));
    onScriptChange(buildRmRfScript(next));
  };

  const isPresetActive = (preset: (typeof TRASH_CLEANUP_PRESETS)[number]) => {
    if (isCustomScript || currentPaths.length === 0) return false;
    return preset.paths.every((p) => currentPaths.includes(p));
  };

  return (
    <SettingsCard
      title="Trash cleanup"
      description="Shell command run from the workspace directory before a git worktree workspace moves to the Trash. Directory-mode workspaces are skipped."
    >
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {TRASH_CLEANUP_PRESETS.map((preset) => {
            const active = isPresetActive(preset);
            return (
              <Button
                key={preset.label}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={isCustomScript}
                onClick={() => togglePreset(preset)}
                title={
                  isCustomScript
                    ? 'Clear the custom script to use presets'
                    : `rm -rf ${preset.paths.join(' ')}`
                }
              >
                {active && <Check className="mr-1 size-3" />}
                {preset.label}
              </Button>
            );
          })}
        </div>
        {/* One line while short, growing as it wraps. The browser sizes it, so a card that mounts
            hidden doesn't measure it at zero height. */}
        <Textarea
          aria-label="Trash cleanup command"
          value={script}
          onChange={(event) => onScriptChange(event.target.value)}
          placeholder="rm -rf node_modules .next dist"
          spellCheck={false}
          rows={1}
          className="block field-sizing-content max-h-[200px] min-h-0 resize-none py-1.5 font-mono text-xs leading-5"
        />
      </div>
    </SettingsCard>
  );
}
