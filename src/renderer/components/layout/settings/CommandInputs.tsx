import {
  CaretDown,
  CaretUp,
  DotsSixVertical,
  Plus,
  Robot,
  ShieldCheck,
  X,
} from '@phosphor-icons/react';
import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useNewWorkspaceShortcutLabel } from '@/lib/agent-dialog-shortcuts';
import { AGENT_OPTION_CARD_IDS } from '@/lib/agent-option-cards';
import {
  getLaunchModeColor,
  LAUNCH_MODE_COLORS,
  LAUNCH_MODE_DOT_CLASSES,
} from '@/lib/launch-mode-colors';
import { LEVEL_PICKER_ICON_COMPONENTS } from '@/lib/level-picker-icons';
import { cn } from '@/lib/utils';

import { agentLaunchPolicy } from '../../../../shared/lib/launch-mode-permissions';
import {
  DEFAULT_LEVEL_PICKER_TITLE,
  DEFAULT_MODEL_PICKER_TITLE,
  levelPickerOf,
  modelPickerOf,
} from '../../../../shared/lib/level-picker';
import {
  LEVEL_PICKER_ICONS,
  MAX_LEVEL_PICKER_TITLE_LENGTH,
  MAX_REASONING_LEVEL_NAME_LENGTH,
  MAX_REASONING_LEVELS,
  MAX_MODEL_OPTIONS,
  type AgentLaunchPolicy,
  type LaunchMode,
  type LevelPickerIcon,
  type ReasoningLevel,
  type ModelOption,
  type LevelPicker,
} from '../../../../shared/types/agent-preset';

import type { ReactNode } from 'react';

interface CommandInputsProps {
  openCommand: string;
  continueCommand: string;
  promptCommand: string;
  launchModes: LaunchMode[];
  reasoningLevels: ReasoningLevel[];
  onOpenCommandChange: (value: string) => void;
  onContinueCommandChange: (value: string) => void;
  onPromptCommandChange: (value: string) => void;
  onLaunchModesChange: (modes: LaunchMode[]) => void;
  onReasoningLevelsChange: (levels: ReasoningLevel[]) => void;
  /** The level picker's title, icon and visibility; left out, they aren't editable here. */
  levelPicker?: LevelPicker;
  onLevelPickerChange?: (picker: LevelPicker) => void;
  /** The models the new workspace dialog offers; left out, they aren't editable here. */
  models?: ModelOption[];
  onModelsChange?: (models: ModelOption[]) => void;
  /** The model picker's title, icon and visibility. */
  modelPicker?: LevelPicker;
  onModelPickerChange?: (picker: LevelPicker) => void;
  /** If true, always show inputs. If false, show as collapsible "Advanced" section */
  alwaysExpanded?: boolean;
  /** Show example placeholders for launch mode inputs (useful for Custom preset) */
  showExamplePlaceholders?: boolean;
  /** The mode pinned as the agent launch default, which agents may always start. */
  pinnedLaunchModeId?: string;
}

type DropTarget = { id: string; position: 'before' | 'after' };

// The level picker's icon and title. The title input stays as typed; an empty one reads as the
// default.
function LevelPickerLook({
  picker,
  icon,
  defaultTitle,
  titleLabel = 'Picker title',
  onChange,
}: {
  picker: LevelPicker;
  /** The icon shown: the picker's own, else the default for this kind of picker. */
  icon: LevelPickerIcon;
  defaultTitle: string;
  titleLabel?: string;
  onChange: (picker: LevelPicker) => void;
}) {
  const PickerIcon = LEVEL_PICKER_ICON_COMPONENTS[icon];
  return (
    <div className="grid gap-1.5">
      {/* Names what the two controls set: the pill's look in the new workspace dialog. */}
      <span className="text-xs text-muted-foreground">Pill icon and label</span>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="size-9 shrink-0 p-0"
              title={`Icon: ${icon}`}
              aria-label={`Icon: ${icon}`}
            >
              <PickerIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="grid grid-cols-6 gap-1 p-2">
            {LEVEL_PICKER_ICONS.map((name) => {
              const Option = LEVEL_PICKER_ICON_COMPONENTS[name];
              return (
                <button
                  key={name}
                  type="button"
                  aria-label={name}
                  aria-pressed={name === icon}
                  title={name}
                  className={`flex size-7 items-center justify-center rounded transition-colors hover:bg-muted ${name === icon ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
                  onClick={() => onChange({ ...picker, icon: name })}
                >
                  <Option className="size-4" />
                </button>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          value={picker.title ?? ''}
          onChange={(e) => onChange({ ...picker, title: e.target.value })}
          placeholder={defaultTitle}
          aria-label={titleLabel}
          maxLength={MAX_LEVEL_PICKER_TITLE_LENGTH}
          className="h-9 flex-1"
        />
      </div>
    </div>
  );
}

// Phosphor has no slashed robot: draw its robot with a slash, cutting a gap
// around the slash so it reads on any background.
function RobotSlash({ className }: { className?: string }) {
  const maskId = `robot-slash-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg viewBox="0 0 256 256" className={className} fill="currentColor" aria-hidden>
      <mask id={maskId}>
        <rect width="256" height="256" fill="white" />
        <line
          x1="40"
          y1="40"
          x2="216"
          y2="216"
          stroke="black"
          strokeWidth="48"
          strokeLinecap="round"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <Robot size={256} />
      </g>
      <line
        x1="40"
        y1="40"
        x2="216"
        y2="216"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Drag-to-reorder for a list of rows. A row only becomes draggable while its
// grip is pressed, so text in the row's inputs stays selectable.
function useRowReorder<T extends { id: string }>(items: T[], onChange: (items: T[]) => void) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [draggableId, setDraggableId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);

  const updateDropTarget = (target: DropTarget | null) => {
    const current = dropTargetRef.current;
    if (current?.id === target?.id && current?.position === target?.position) return;
    setDropTarget(target);
    dropTargetRef.current = target;
  };

  const reset = () => {
    setDraggedId(null);
    updateDropTarget(null);
  };

  const handleDrop = () => {
    const target = dropTargetRef.current;
    if (draggedId && target && draggedId !== target.id) {
      const reordered = [...items];
      const draggedIndex = reordered.findIndex((item) => item.id === draggedId);
      const [dragged] = reordered.splice(draggedIndex, 1);
      let targetIndex = reordered.findIndex((item) => item.id === target.id);
      if (target.position === 'after') targetIndex += 1;
      reordered.splice(targetIndex, 0, dragged);
      onChange(reordered);
    }
    reset();
  };

  const rowProps = (id: string) => {
    const isDropBefore = dropTarget?.id === id && dropTarget.position === 'before';
    const isDropAfter = dropTarget?.id === id && dropTarget.position === 'after';
    return {
      className: `relative flex items-center gap-2 ${draggedId === id ? 'opacity-40' : ''} ${isDropBefore ? 'drop-indicator-before' : ''} ${isDropAfter ? 'drop-indicator-after' : ''}`,
      draggable: draggableId === id,
      onDragStart: (e: React.DragEvent) => {
        // Text dragged out of an input bubbles here; only the row itself moves.
        if (e.target !== e.currentTarget) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        setDraggedId(id);
      },
      onDragEnd: () => {
        reset();
        setDraggableId(null);
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!draggedId) return;
        // Back over its own row: dropping there leaves the order alone.
        if (id === draggedId) {
          updateDropTarget(null);
          return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const threshold = rect.height * 0.5;
        updateDropTarget({
          id,
          position: e.clientY < rect.top + threshold ? 'before' : 'after',
        });
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        handleDrop();
      },
    };
  };

  const gripProps = (id: string) => ({
    onMouseDown: () => setDraggableId(id),
    onMouseUp: () => setDraggableId(null),
  });

  return { rowProps, gripProps };
}

const AGENT_LAUNCH_CHOICES: Array<{ policy: AgentLaunchPolicy; label: string; status: string }> = [
  { policy: 'always', label: 'Anywhere', status: 'Agents can start this mode anywhere' },
  {
    policy: 'isolated',
    label: 'Only on an isolated SSH host',
    status: 'Agents can start this mode only on an isolated SSH host',
  },
  { policy: 'never', label: 'Never', status: "Agents can't start this mode" },
];

// Where agents may start a mode in new tabs and workspaces.
function AgentLaunchMenu({
  mode,
  onChange,
}: {
  mode: LaunchMode;
  onChange: (policy: AgentLaunchPolicy) => void;
}) {
  const policy = agentLaunchPolicy(mode);
  const current = AGENT_LAUNCH_CHOICES.find((choice) => choice.policy === policy)!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={current.status} size="md">
          {policy === 'always' ? (
            <Robot className="size-4" />
          ) : policy === 'isolated' ? (
            <ShieldCheck className="size-4" />
          ) : (
            <RobotSlash className="size-4 text-error" />
          )}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Agents may start this mode</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={policy}
          onValueChange={(value) => onChange(value as AgentLaunchPolicy)}
        >
          {AGENT_LAUNCH_CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.policy} value={choice.policy}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NO_MODELS: ModelOption[] = [];
const IGNORE_MODELS = () => {};

// Names the two inputs of a level or model row, lined up with them.
function RowColumnHeaders({
  nameLabel,
  leading = 1,
  trailing = 1,
}: {
  nameLabel: string;
  /** The small controls before the name, such as the drag grip and a color dot. */
  leading?: number;
  /** The buttons after the arguments. */
  trailing?: number;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden>
      {Array.from({ length: leading }, (_, index) => (
        <span key={`lead-${index}`} className="size-4 shrink-0" />
      ))}
      <span className="flex-[2]">{nameLabel}</span>
      <span className="flex-[3]">Arguments</span>
      {Array.from({ length: trailing }, (_, index) => (
        <span key={`trail-${index}`} className="size-8 shrink-0" />
      ))}
    </div>
  );
}

/** Each group after the commands starts under a hairline, so the groups read apart. */
const SECTION_CLASS = 'border-t border-border/50 pt-5';

export function CommandInputs({
  openCommand,
  continueCommand,
  promptCommand,
  launchModes,
  reasoningLevels,
  onOpenCommandChange,
  onContinueCommandChange,
  onPromptCommandChange,
  onLaunchModesChange,
  onReasoningLevelsChange,
  levelPicker,
  onLevelPickerChange,
  models,
  onModelsChange,
  modelPicker,
  onModelPickerChange,
  alwaysExpanded = false,
  showExamplePlaceholders = false,
  pinnedLaunchModeId,
}: CommandInputsProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fieldId = useId();
  const cycleLaunchModeShortcut = useNewWorkspaceShortcutLabel('cycleLaunchMode');
  const modeReorder = useRowReorder(launchModes, onLaunchModesChange);
  const levelReorder = useRowReorder(reasoningLevels, onReasoningLevelsChange);
  const modelReorder = useRowReorder(models ?? NO_MODELS, onModelsChange ?? IGNORE_MODELS);

  const handleAddMode = () => {
    onLaunchModesChange([...launchModes, { id: crypto.randomUUID(), name: '', arguments: '' }]);
  };

  const handleRemoveMode = (id: string) => {
    onLaunchModesChange(launchModes.filter((m) => m.id !== id));
  };

  const handleUpdateMode = (id: string, field: 'name' | 'arguments' | 'color', value: string) => {
    onLaunchModesChange(
      launchModes.map((m) => (m.id === id ? { ...m, [field]: value || undefined } : m))
    );
  };

  const handleAgentLaunchChange = (id: string, agentLaunch: AgentLaunchPolicy) => {
    onLaunchModesChange(launchModes.map((m) => (m.id === id ? { ...m, agentLaunch } : m)));
  };

  const handleAddLevel = () => {
    onReasoningLevelsChange([
      ...reasoningLevels,
      {
        id: crypto.randomUUID(),
        name: '',
        arguments: '',
      },
    ]);
  };

  const handleRemoveLevel = (id: string) => {
    onReasoningLevelsChange(reasoningLevels.filter((level) => level.id !== id));
  };

  const handleUpdateLevel = (id: string, field: 'name' | 'arguments', value: string) => {
    onReasoningLevelsChange(
      reasoningLevels.map((level) => (level.id === id ? { ...level, [field]: value } : level))
    );
  };

  const handleUpdateModel = (id: string, field: 'name' | 'arguments', value: string) => {
    onModelsChange?.((models ?? []).map((m) => (m.id === id ? { ...m, [field]: value } : m)));
  };

  const commandField = (
    key: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
    help: ReactNode
  ) => (
    <div className="grid gap-1.5">
      <label htmlFor={`${fieldId}-${key}`} className="text-[13px] font-medium">
        {label}
      </label>
      <Input
        id={`${fieldId}-${key}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="h-9 font-mono text-[13px]"
      />
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );

  const inputs = (
    <>
      <div className="grid gap-4">
        {commandField(
          'open',
          'Open command',
          openCommand,
          onOpenCommandChange,
          'e.g., claude {{launchMode}}',
          'Starts a new session.'
        )}
        {commandField(
          'continue',
          'Continue command',
          continueCommand,
          onContinueCommandChange,
          'e.g., claude --resume {{launchMode}}',
          'Resumes, or picks, an existing session in this worktree.'
        )}
        {commandField(
          'prompt',
          'Prompt command',
          promptCommand,
          onPromptCommandChange,
          'e.g., claude {{launchMode}} {{prompt}}',
          <>
            Starts with an initial prompt, placed at{' '}
            <code className="font-mono">{'{{prompt}}'}</code>.
          </>
        )}
      </div>

      <div
        id={AGENT_OPTION_CARD_IDS.launchModes}
        className={cn('grid scroll-mt-4 gap-2', SECTION_CLASS)}
      >
        <h3 className="text-sm font-semibold">Launch modes</h3>
        <p className="-mt-1 text-xs leading-relaxed text-pretty text-muted-foreground">
          Arguments to switch between when starting the agent
          {cycleLaunchModeShortcut &&
            `, with ${cycleLaunchModeShortcut} in the new workspace dialog`}
          . They go at <code className="font-mono">{'{{launchMode}}'}</code>, or at the end. The
          button before the × sets where agents may start that mode; ones that skip permission
          prompts start out limited to SSH hosts marked isolated.
        </p>
        {launchModes.length > 0 && (
          <RowColumnHeaders nameLabel="Mode name" leading={2} trailing={2} />
        )}
        {launchModes.map((mode, index) => {
          const currentColor = getLaunchModeColor(mode.color, index);
          const exampleNames = ['e.g., Plan', 'e.g., Accept edits', 'e.g., Full auto'];
          const exampleArguments = [
            'e.g., --permission-mode plan',
            'e.g., --permission-mode acceptEdits',
            'e.g., --dangerously-skip-permissions',
          ];
          return (
            <div key={mode.id} {...modeReorder.rowProps(mode.id)}>
              <DotsSixVertical
                className="size-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
                {...modeReorder.gripProps(mode.id)}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={`size-4 shrink-0 rounded-full ${LAUNCH_MODE_DOT_CLASSES[currentColor]} ring-offset-background transition-shadow hover:ring-2 hover:ring-offset-1`}
                    title={`Color: ${currentColor}`}
                    aria-label={`Color: ${currentColor}`}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="flex gap-1.5 p-2">
                  {LAUNCH_MODE_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={color}
                      aria-pressed={color === currentColor}
                      className={`size-5 rounded-full border-2 transition-transform hover:scale-110 ${LAUNCH_MODE_DOT_CLASSES[color]} ${color === currentColor ? 'border-foreground ring-2 ring-foreground/20' : 'border-transparent'}`}
                      onClick={() => handleUpdateMode(mode.id, 'color', color)}
                    />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Input
                value={mode.name}
                onChange={(e) => handleUpdateMode(mode.id, 'name', e.target.value)}
                placeholder={showExamplePlaceholders ? exampleNames[index] || 'Name' : 'Name'}
                className="h-9 flex-[2]"
              />
              <Input
                value={mode.arguments ?? ''}
                onChange={(e) => handleUpdateMode(mode.id, 'arguments', e.target.value)}
                placeholder={
                  showExamplePlaceholders
                    ? exampleArguments[index] || 'e.g., --permission-mode plan'
                    : index === 0
                      ? 'e.g., --permission-mode plan'
                      : undefined
                }
                spellCheck={false}
                className="h-9 flex-[3] font-mono text-[13px]"
              />
              {mode.id === pinnedLaunchModeId ? (
                <IconButton
                  label="Agents can always start the agent launch default"
                  size="md"
                  // aria-disabled, not disabled, so the tooltip still says why.
                  aria-disabled
                >
                  <Robot className="size-4" />
                </IconButton>
              ) : (
                <AgentLaunchMenu
                  mode={mode}
                  onChange={(policy) => handleAgentLaunchChange(mode.id, policy)}
                />
              )}
              <IconButton label="Remove mode" size="md" onClick={() => handleRemoveMode(mode.id)}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={handleAddMode}>
          <Plus className="mr-1 size-3.5" />
          Add mode
        </Button>
      </div>

      <div
        id={AGENT_OPTION_CARD_IDS.effort}
        className={cn('grid scroll-mt-4 gap-2', SECTION_CLASS)}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Effort picker</h3>
          {levelPicker && onLevelPickerChange && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Show in the new workspace dialog
              <Switch
                checked={!levelPickerOf({ levelPicker }).hidden}
                onCheckedChange={(shown) => onLevelPickerChange({ ...levelPicker, hidden: !shown })}
              />
            </label>
          )}
        </div>
        <p className="-mt-1 text-xs leading-relaxed text-pretty text-muted-foreground">
          Levels for the effort pill in the new workspace dialog, lowest first. Resumes keep them.
        </p>
        {levelPicker && onLevelPickerChange && (
          <LevelPickerLook
            picker={levelPicker}
            icon={levelPickerOf({ levelPicker }).icon}
            defaultTitle={DEFAULT_LEVEL_PICKER_TITLE}
            onChange={onLevelPickerChange}
          />
        )}
        {reasoningLevels.length === 0 && (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            No levels yet. Add the flag your agent uses for how hard it thinks, such as{' '}
            <code>--effort high</code>, <code>--thinking high</code> or{' '}
            <code>--reasoning high</code>.
          </p>
        )}
        {reasoningLevels.length > 0 && <RowColumnHeaders nameLabel="Level name" />}
        {reasoningLevels.map((level) => (
          <div key={level.id} {...levelReorder.rowProps(level.id)}>
            <DotsSixVertical
              className="size-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
              {...levelReorder.gripProps(level.id)}
            />
            <Input
              value={level.name}
              onChange={(e) => handleUpdateLevel(level.id, 'name', e.target.value)}
              placeholder="e.g., High"
              maxLength={MAX_REASONING_LEVEL_NAME_LENGTH}
              className="h-9 flex-[2]"
            />
            <Input
              value={level.arguments}
              onChange={(e) => handleUpdateLevel(level.id, 'arguments', e.target.value)}
              placeholder="e.g., --effort high"
              spellCheck={false}
              className="h-9 flex-[3] font-mono text-[13px]"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-8 shrink-0 p-0"
              title={`Remove effort level${level.name ? ` ${level.name}` : ''}`}
              onClick={() => handleRemoveLevel(level.id)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={reasoningLevels.length >= MAX_REASONING_LEVELS}
          onClick={handleAddLevel}
        >
          <Plus className="mr-1 size-3.5" />
          Add level
        </Button>
      </div>

      {models && onModelsChange && (
        <div
          id={AGENT_OPTION_CARD_IDS.models}
          className={cn('grid scroll-mt-4 gap-2', SECTION_CLASS)}
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Model picker</h3>
            {modelPicker && onModelPickerChange && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Show in the new workspace dialog
                <Switch
                  aria-label="Show model picker in the new workspace dialog"
                  checked={!modelPickerOf({ modelPicker }).hidden}
                  onCheckedChange={(shown) =>
                    onModelPickerChange({ ...modelPicker, hidden: !shown })
                  }
                />
              </label>
            )}
          </div>
          <p className="-mt-1 text-xs leading-relaxed text-pretty text-muted-foreground">
            Models for the model pill in the new workspace dialog. Resumes keep them.
          </p>
          {modelPicker && onModelPickerChange && (
            <LevelPickerLook
              picker={modelPicker}
              icon={modelPickerOf({ modelPicker }).icon}
              defaultTitle={DEFAULT_MODEL_PICKER_TITLE}
              titleLabel="Model picker title"
              onChange={onModelPickerChange}
            />
          )}
          {models.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              No models yet. Add the flag your agent uses to pick one, such as{' '}
              <code>--model opus</code> or <code>-m gpt-5</code>.
            </p>
          )}
          {models.length > 0 && <RowColumnHeaders nameLabel="Model name" />}
          {models.map((model) => (
            <div key={model.id} {...modelReorder.rowProps(model.id)}>
              <DotsSixVertical
                className="size-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
                {...modelReorder.gripProps(model.id)}
              />
              <Input
                value={model.name}
                onChange={(e) => handleUpdateModel(model.id, 'name', e.target.value)}
                placeholder="e.g., Sonnet"
                maxLength={MAX_REASONING_LEVEL_NAME_LENGTH}
                className="h-9 flex-[2]"
              />
              <Input
                value={model.arguments}
                onChange={(e) => handleUpdateModel(model.id, 'arguments', e.target.value)}
                placeholder="e.g., --model sonnet"
                spellCheck={false}
                className="h-9 flex-[3] font-mono text-[13px]"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 shrink-0 p-0"
                title={`Remove model${model.name ? ` ${model.name}` : ''}`}
                onClick={() => onModelsChange(models.filter((m) => m.id !== model.id))}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={models.length >= MAX_MODEL_OPTIONS}
            onClick={() =>
              onModelsChange([
                ...models,
                {
                  id: crypto.randomUUID(),
                  name: '',
                  arguments: '',
                },
              ])
            }
          >
            <Plus className="mr-1 size-3.5" />
            Add model
          </Button>
        </div>
      )}
    </>
  );

  if (alwaysExpanded) {
    return <div className="flex flex-col gap-6">{inputs}</div>;
  }

  return (
    <>
      <button
        type="button"
        className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? <CaretUp className="size-4" /> : <CaretDown className="size-4" />}
        {showAdvanced ? 'Hide advanced' : 'Show advanced'}
      </button>

      {showAdvanced && inputs}
    </>
  );
}
