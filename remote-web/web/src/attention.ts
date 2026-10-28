import { isRemoteAttentionCustomTitle, type RemoteWorkspaceSummary } from '@komla/remote-protocol';

type RemoteWorkspaceAttention = NonNullable<RemoteWorkspaceSummary['attention']>;

export function attentionMessageIsLabel(attention: RemoteWorkspaceAttention): boolean {
  const message = attention.message?.trim();
  return Boolean(
    message && (attention.kind === 'generic' || isRemoteAttentionCustomTitle(attention.source))
  );
}

export function attentionLabel(attention: RemoteWorkspaceAttention): string {
  const message = attention.message?.trim();
  if (message && attentionMessageIsLabel(attention)) return message;

  switch (attention.kind) {
    case 'input-required':
      return 'Input';
    case 'turn-complete':
      return 'Done';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Idle';
    default:
      return 'Notice';
  }
}
