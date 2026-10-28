import { UploadSimple } from '@phosphor-icons/react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toast.store';
import { stripErrorPrefix } from '@/utils/workspace-error';

import type { ProjectIconCandidate } from '@/types';

interface ProjectIconPickerProps {
  /** The picked icon's data URL, or empty for the color dot. */
  value: string;
  onChange: (icon: string) => void;
  candidates: ProjectIconCandidate[];
  /** The project's color, shown on the color dot choice. */
  color: string;
  label?: string;
  /** `lg` shows bigger tiles captioned with each file's name. */
  size?: 'sm' | 'lg';
  disabled?: boolean;
  className?: string;
}

/**
 * The color dot, then each image found in the project's files, to show as its icon, and a
 * button to upload any other image.
 */
export function ProjectIconPicker({
  value,
  onChange,
  candidates,
  color,
  label,
  size = 'sm',
  disabled,
  className,
}: ProjectIconPickerProps) {
  const addToast = useToastStore((s) => s.addToast);
  // Uploaded images stay choices while the picker is open, newest first.
  const [uploads, setUploads] = useState<ProjectIconCandidate[]>([]);
  const options = [
    ...uploads.filter((upload) => !candidates.some((c) => c.dataUrl === upload.dataUrl)),
    ...candidates,
  ];

  const upload = async () => {
    try {
      const icon = await window.api.chooseProjectIconFile();
      if (!icon) return;
      setUploads((current) => [icon, ...current.filter((c) => c.dataUrl !== icon.dataUrl)]);
      onChange(icon.dataUrl);
    } catch (err) {
      addToast(stripErrorPrefix(err as Error), 'error');
    }
  };

  const large = size === 'lg';
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {label && <span className="text-sm font-medium whitespace-nowrap">{label}</span>}
      <div className={cn('flex flex-wrap items-center', large ? 'gap-2' : 'gap-1.5')}>
        {/* Laid out with the upload button, so they wrap as one row. */}
        <div role="group" aria-label={label ?? 'Project icon'} className="contents">
          <IconOption
            label="Color dot"
            caption="Color dot"
            size={size}
            selected={!value}
            disabled={disabled}
            onClick={() => onChange('')}
          >
            <span
              className={cn('rounded-full', large ? 'size-3' : 'size-2.5')}
              style={{ backgroundColor: color }}
            />
          </IconOption>
          {options.map((option) => (
            <IconOption
              key={option.dataUrl}
              label={option.path}
              caption={option.path.split('/').pop()!}
              size={size}
              selected={option.dataUrl === value}
              disabled={disabled}
              onClick={() => onChange(option.dataUrl)}
            >
              <img
                src={option.dataUrl}
                alt=""
                draggable={false}
                className={cn('rounded-[3px] object-contain', large ? 'size-7' : 'size-4')}
              />
            </IconOption>
          ))}
        </div>
        <IconOption
          label="Upload icon…"
          caption="Upload…"
          size={size}
          disabled={disabled}
          onClick={() => void upload()}
        >
          <UploadSimple className={cn('text-muted-foreground', large ? 'size-5' : 'size-3.5')} />
        </IconOption>
      </div>
    </div>
  );
}

function IconOption({
  label,
  caption,
  size,
  selected,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** Shown under the image on `lg` tiles. */
  caption: string;
  size: 'sm' | 'lg';
  /** Undefined for a button that isn't a choice. */
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center justify-center border-2 ring-offset-background transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        size === 'lg'
          ? 'w-[72px] flex-col gap-1.5 rounded-lg px-1 pt-2.5 pb-1.5'
          : 'size-7 rounded-md',
        selected
          ? 'border-foreground bg-muted'
          : size === 'sm'
            ? 'border-transparent'
            : selected === undefined
              ? 'border-dashed border-foreground/15'
              : 'border-transparent bg-foreground/[0.04]'
      )}
    >
      {size === 'lg' ? (
        <>
          <span className="flex size-8 items-center justify-center">{children}</span>
          <span
            className={cn(
              'w-full truncate text-center text-2xs',
              selected ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {caption}
          </span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
