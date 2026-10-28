import { Key, ShieldWarning } from '@phosphor-icons/react';
import { useState, useEffect, useRef, useCallback } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import type { AskpassRequest } from '../../../shared/types';

interface PassphraseDialogProps {
  open: boolean;
  request: AskpassRequest | null;
  onResponse: (id: string, passphrase: string | null, remember?: boolean) => void;
}

function secondsUntil(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

export type PromptInfo =
  | { kind: 'passphrase'; keyPath: string | null }
  | {
      kind: 'host-verification';
      host: string | null;
      fingerprint: string | null;
      fullMessage: string;
    }
  | { kind: 'unknown'; displayPrompt: string };

export function parsePrompt(prompt: string): PromptInfo {
  // Host key verification: "Are you sure you want to continue connecting (yes/no/[fingerprint])?"
  // or "The authenticity of host '...' can't be established."
  if (
    /Are you sure you want to continue connecting/.test(prompt) ||
    /authenticity of host/.test(prompt)
  ) {
    const hostMatch = prompt.match(/authenticity of host '([^']+)'/);
    const fingerprintMatch = prompt.match(/fingerprint is (\S+:\S+[^.\s])/);
    return {
      kind: 'host-verification',
      host: hostMatch ? hostMatch[1] : null,
      fingerprint: fingerprintMatch ? fingerprintMatch[1] : null,
      fullMessage: prompt,
    };
  }

  // SSH passphrase: "Enter passphrase for key '/path/to/key': " from ssh, or
  // "Enter passphrase for /path/to/key: " from ssh-add. Anchored so a server's prompt,
  // which ssh prefixes with "(user@host) ", isn't shown as a local key.
  const passphraseMatch = prompt.match(/^Enter passphrase for (?:key '(.+)'|(.+?)):\s*$/);
  if (passphraseMatch) {
    return {
      kind: 'passphrase',
      keyPath: passphraseMatch[1] ?? passphraseMatch[2],
    };
  }

  // Unknown prompt
  return {
    kind: 'unknown',
    displayPrompt: prompt,
  };
}

/**
 * Dialog for entering SSH passphrase when git operations need it.
 *
 * This dialog is shown when:
 * - A background git operation (fetch, push, pull, clone) encounters an SSH key
 * - The SSH key requires a passphrase
 * - The passphrase is not cached in ssh-agent
 * - SSH encounters an unknown host key that needs verification
 */
export function PassphraseDialog({ open, request, onResponse }: PassphraseDialogProps) {
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(() =>
    request ? secondsUntil(request.expiresAt) : 0
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // Use refs to store current values for use in timer callbacks
  const requestRef = useRef(request);
  const onResponseRef = useRef(onResponse);

  // Keep refs up to date
  useEffect(() => {
    requestRef.current = request;
    onResponseRef.current = onResponse;
  }, [request, onResponse]);

  const handleCancel = useCallback(() => {
    if (requestRef.current) {
      onResponseRef.current(requestRef.current.id, null);
    }
    setPassphrase('');
  }, []);

  const promptInfo = request ? parsePrompt(request.prompt) : null;
  const hasInput = promptInfo?.kind !== 'host-verification';
  const canRemember = request?.canRemember ?? false;
  const requestId = request?.id;
  const expiresAt = request?.expiresAt;

  // Reset the form when a new request is shown
  const [shownRequestId, setShownRequestId] = useState(requestId);
  if (requestId !== shownRequestId) {
    setShownRequestId(requestId);
    setPassphrase('');
    setRemember(false);
  }

  // Focus the input after a short delay to ensure it's mounted
  useEffect(() => {
    if (!open || !requestId || !hasInput) return;
    const timeout = setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timeout);
  }, [open, requestId, hasInput]);

  // Count down to Komla's deadline for the request, then cancel it
  useEffect(() => {
    if (!open || expiresAt === undefined) return;

    const tick = () => {
      const seconds = secondsUntil(expiresAt);
      setTimeRemaining(seconds);
      if (seconds === 0) {
        clearInterval(interval);
        handleCancel();
      }
    };
    const interval = setInterval(tick, 1000);
    tick();
    return () => clearInterval(interval);
  }, [open, expiresAt, handleCancel]);

  const handleSubmit = useCallback(() => {
    if (requestRef.current && passphrase) {
      onResponseRef.current(requestRef.current.id, passphrase, canRemember && remember);
      setPassphrase('');
    }
  }, [passphrase, canRemember, remember]);

  const handleTrust = useCallback(() => {
    if (requestRef.current) {
      onResponseRef.current(requestRef.current.id, 'yes');
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && passphrase) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    },
    [passphrase, handleSubmit, handleCancel]
  );

  // Format time remaining as MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          handleCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        {promptInfo?.kind === 'host-verification' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldWarning className="size-5" />
                Verify SSH Host
              </DialogTitle>
              <DialogDescription>
                A git operation is connecting to an unknown SSH host.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {promptInfo.host && (
                <div className="space-y-1">
                  <label className="block text-xs text-muted-foreground">Host</label>
                  <p className="text-sm font-semibold">{promptInfo.host}</p>
                </div>
              )}

              {promptInfo.fingerprint && (
                <div className="space-y-1">
                  <label className="block text-xs text-muted-foreground">Fingerprint</label>
                  <p className="font-mono text-sm break-all">{promptInfo.fingerprint}</p>
                </div>
              )}

              <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                {promptInfo.fullMessage}
              </p>

              <p className="text-xs text-muted-foreground">
                Timeout in {formatTime(timeRemaining)}
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                Reject
              </Button>
              <Button onClick={handleTrust}>Trust</Button>
            </DialogFooter>
          </>
        ) : promptInfo?.kind === 'passphrase' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Key className="size-5" />
                SSH Passphrase Required
              </DialogTitle>
              <DialogDescription>Enter the passphrase for your SSH key</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {promptInfo.keyPath && (
                <div className="space-y-1">
                  <label className="block text-xs text-muted-foreground">SSH Key</label>
                  <p className="font-mono text-sm break-all">{promptInfo.keyPath}</p>
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="passphrase" className="block text-sm font-medium">
                  Passphrase
                </label>
                <Input
                  ref={inputRef}
                  id="passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Enter your SSH key passphrase"
                  autoComplete="off"
                  autoFocus
                />
              </div>

              {canRemember && (
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                  />
                  Remember until Komla quits
                </label>
              )}

              <p className="text-xs text-muted-foreground">
                Timeout in {formatTime(timeRemaining)}
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!passphrase}>
                Unlock
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Key className="size-5" />
                SSH Authentication
              </DialogTitle>
              <DialogDescription>{promptInfo?.displayPrompt}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <label htmlFor="passphrase" className="block text-sm font-medium">
                  Response
                </label>
                <Input
                  ref={inputRef}
                  id="passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoComplete="off"
                  autoFocus
                />
              </div>

              <p className="text-xs text-muted-foreground">
                Timeout in {formatTime(timeRemaining)}
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!passphrase}>
                Submit
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
