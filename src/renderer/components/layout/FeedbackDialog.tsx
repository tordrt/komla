import { Bug, Lightbulb, ChatCircle, EnvelopeSimple, Image, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { useLicenseStore } from '@/stores/license.store';
import { useToastStore } from '@/stores/toast.store';

import type { FeedbackType } from '@/types';

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TYPE_OPTIONS: readonly SegmentedControlOption<FeedbackType>[] = [
  { value: 'bug', label: 'Bug report', icon: <Bug className="size-3.5" /> },
  { value: 'feature', label: 'Feature request', icon: <Lightbulb className="size-3.5" /> },
  { value: 'general', label: 'General', icon: <ChatCircle className="size-3.5" /> },
];

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const [type, setType] = useState<FeedbackType>('general');
  const [description, setDescription] = useState('');
  const [email, setEmail] = useState('');
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasPrefilledEmail = useRef(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const { addToast } = useToastStore();
  const licenseStatus = useLicenseStore((state) => state.status);
  const loadLicenseStatus = useLicenseStore((state) => state.loadStatus);
  const contactEmail = licenseStatus?.customerEmail ?? null;

  useEffect(() => {
    if (open && !licenseStatus) {
      void loadLicenseStatus();
    }
  }, [open, licenseStatus, loadLicenseStatus]);

  useEffect(() => {
    if (open && contactEmail && !email && !hasPrefilledEmail.current) {
      setEmail(contactEmail);
      hasPrefilledEmail.current = true;
    }
  }, [open, contactEmail, email]);

  const resetForm = () => {
    setType('general');
    setDescription('');
    setEmail('');
    setScreenshots([]);
    setError(null);
    hasPrefilledEmail.current = false;
  };

  // Keep the draft when the dialog is dismissed; it is cleared only after a successful send.
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setError(null);
    }
    onOpenChange(newOpen);
  };

  const handleSelectScreenshots = async () => {
    const currentCount = screenshots.length;
    if (currentCount >= 3) return;

    const paths = await window.api.selectScreenshots();
    if (paths.length > 0) {
      // Limit total to 3
      const newScreenshots = [...screenshots, ...paths].slice(0, 3);
      setScreenshots(newScreenshots);
    }
  };

  const handleRemoveScreenshot = (index: number) => {
    setScreenshots(screenshots.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    // Validation
    if (description.trim().length < 2) {
      setError('Description must be at least 2 characters');
      return;
    }

    if (email && !isValidEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const result = await window.api.sendFeedback({
        type,
        description: description.trim(),
        email: email.trim() || undefined,
        screenshotPaths: screenshots.length > 0 ? screenshots : undefined,
      });

      if (result.success) {
        addToast('Feedback sent successfully!', 'success');
        resetForm();
        onOpenChange(false);
      } else {
        setError(result.error || 'Failed to send feedback');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValidEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const getFilename = (path: string): string => {
    return path.split(/[/\\]/).pop() || path;
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={(event) => {
          // Straight to writing, rather than a focus ring on the type picker.
          event.preventDefault();
          descriptionRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription className="sr-only">
            Report a bug, request a feature, or share general feedback
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          <SegmentedControl
            aria-label="Feedback type"
            value={type}
            onValueChange={setType}
            options={TYPE_OPTIONS}
            size="md"
            fill
            disabled={isSubmitting}
          />

          {/* The message and its screenshots share one box, as in a chat composer. */}
          <div className="rounded-md border border-input transition-colors focus-within:border-foreground/30">
            <textarea
              ref={descriptionRef}
              aria-label="Description"
              className="block field-sizing-content max-h-80 min-h-28 w-full resize-none bg-transparent px-3 pt-2.5 text-sm leading-relaxed outline-hidden placeholder:text-muted-foreground/60 disabled:opacity-50"
              placeholder={
                type === 'bug'
                  ? 'Describe what happened and how to reproduce it...'
                  : type === 'feature'
                    ? 'Describe the feature you would like to see...'
                    : 'Share your thoughts...'
              }
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
            />
            <div className="flex flex-col gap-1 px-2 pt-1 pb-2">
              {screenshots.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {screenshots.map((path, index) => (
                    <div
                      key={path}
                      className="flex h-7 items-center gap-1.5 rounded-md bg-muted pr-1 pl-2 text-xs"
                    >
                      <Image className="size-3.5 text-muted-foreground" />
                      <span className="max-w-[140px] truncate">{getFilename(path)}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveScreenshot(index)}
                        className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        disabled={isSubmitting}
                        aria-label={`Remove ${getFilename(path)}`}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {screenshots.length < 3 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 self-start px-2 text-xs text-muted-foreground"
                  title="PNG, JPG, GIF or WebP, up to 3"
                  onClick={handleSelectScreenshots}
                  disabled={isSubmitting}
                >
                  <Image className="mr-1.5 size-3.5" />
                  Add screenshot
                </Button>
              )}
            </div>
          </div>

          <div className="relative">
            <EnvelopeSimple className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="email"
              aria-label="Email"
              placeholder="Email, if you'd like a reply (optional)"
              className="h-9 bg-transparent pl-9 focus-visible:border-foreground/30 focus-visible:ring-0 focus-visible:ring-offset-0"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
        </DialogBody>

        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || description.trim().length < 2}>
            {isSubmitting && <Spinner size="md" className="mr-2" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
