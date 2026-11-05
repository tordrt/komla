import { useEffect, useState } from 'react';

import type {
  AutomationCommandPreview,
  AutomationCommandPreviewParams,
} from '../../../../shared/types/automation';

const PREVIEW_DELAY_MS = 150;

/** The command a run starts, read again shortly after the agent choice stops changing. */
function useCommandPreview(
  params: AutomationCommandPreviewParams | undefined
): AutomationCommandPreview | undefined {
  const [preview, setPreview] = useState<AutomationCommandPreview>();
  const key = params ? JSON.stringify(params) : undefined;
  useEffect(() => {
    if (!key) {
      setPreview(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      window.api.previewAutomationCommand(JSON.parse(key) as AutomationCommandPreviewParams).then(
        (result) => current && setPreview(result),
        () => current && setPreview(undefined)
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key]);
  return preview;
}

/**
 * The agent command each run starts, with `<prompt>` for the prompt, so the launch mode, level
 * and extra arguments can be checked together. Undefined params show nothing, e.g. while the
 * extra arguments can't be saved.
 */
export function AutomationCommandPreviewLine({
  params,
}: {
  params: AutomationCommandPreviewParams | undefined;
}) {
  const preview = useCommandPreview(params);
  if (!params || !preview) return null;
  if ('problem' in preview) {
    return <p className="text-xs text-muted-foreground">{preview.problem}</p>;
  }
  return (
    <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">
        {params.target.kind === 'ssh' ? 'Each run starts on the host' : 'Each run starts'}
      </span>
      <code
        data-testid="automation-command-preview"
        className="min-w-0 rounded-sm bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-xs break-all whitespace-pre-wrap text-foreground/90"
      >
        {preview.command}
      </code>
    </div>
  );
}
