import { readFileSync } from 'fs';
import { join } from 'path';

import {
  ACTION_SSH_EXECUTION_LOCATIONS,
  SETUP_DESTINATIONS,
  SETUP_TRIGGERS,
} from '../../../../shared/types';
import { getKomlaBasePath } from '../../paths';

import type http from 'http';

type SettingsValidationFile = 'projects' | 'actions';

interface SettingsValidationResult {
  ok: boolean;
  files: Record<
    SettingsValidationFile,
    {
      ok: boolean;
      count?: number;
      warning?: string;
      error?: string;
    }
  >;
}

function stripUtf8Bom(data: string): { value: string; hadBom: boolean } {
  if (data.charCodeAt(0) === 0xfeff) {
    return { value: data.slice(1), hadBom: true };
  }
  return { value: data, hadBom: false };
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'number';
}

function hasBoolean(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'boolean';
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function hasOptionalNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'number';
}

function hasOptionalNullableNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] == null || typeof value[key] === 'number';
}

function hasOptionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'boolean';
}

function hasOptionalStringArray(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  return (
    field === undefined || (Array.isArray(field) && field.every((item) => typeof item === 'string'))
  );
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function hasOptionalEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[]
): boolean {
  return value[key] === undefined || isOneOf(value[key], allowed);
}

function isValidSetupStep(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as Record<string, unknown>;
  const agent = step['agent'];
  return (
    hasString(step, 'id') &&
    hasString(step, 'name') &&
    hasString(step, 'command') &&
    isOneOf(step['placement'], ['background', 'tab', 'split-right', 'split-bottom']) &&
    hasOptionalString(step, 'actionId') &&
    (agent === undefined ||
      (typeof agent === 'object' &&
        agent !== null &&
        !Array.isArray(agent) &&
        hasOptionalString(agent as Record<string, unknown>, 'presetId') &&
        hasOptionalString(agent as Record<string, unknown>, 'launchModeId'))) &&
    hasOptionalEnum(step, 'destination', SETUP_DESTINATIONS) &&
    hasOptionalEnum(step, 'trigger', SETUP_TRIGGERS)
  );
}

function hasOptionalSetupSteps(value: Record<string, unknown>): boolean {
  const setupSteps = value['setupSteps'];
  return (
    setupSteps === undefined ||
    (Array.isArray(setupSteps) && setupSteps.every((step) => isValidSetupStep(step)))
  );
}

function findDuplicateIdIndex(entries: Array<Record<string, unknown>>): number {
  const seen = new Set<string>();
  return entries.findIndex((entry) => {
    const id = entry['id'];
    if (typeof id !== 'string') return false;
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
}

function isValidProjectEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Record<string, unknown>;
  return (
    hasString(project, 'id') &&
    hasString(project, 'name') &&
    hasString(project, 'repositoryPath') &&
    hasString(project, 'defaultBranchPrefix') &&
    hasNumber(project, 'createdAt') &&
    hasNumber(project, 'order') &&
    hasBoolean(project, 'managed') &&
    hasOptionalString(project, 'color') &&
    hasOptionalSetupSteps(project) &&
    hasOptionalString(project, 'baseBranch') &&
    hasOptionalEnum(project, 'agentPlacement', ['tab', 'split-right', 'split-bottom']) &&
    hasOptionalNumber(project, 'agentLayoutOrder') &&
    hasOptionalString(project, 'trashCleanupScript') &&
    hasOptionalString(project, 'managedRepoPath') &&
    hasOptionalEnum(project, 'aheadTargetAction', [
      'auto-default',
      'auto',
      'unconfigured',
      'merge',
      'pr',
      'disabled',
      'agent-prompt',
    ]) &&
    hasOptionalBoolean(project, 'autoPushAfterMerge') &&
    hasOptionalString(project, 'aheadTargetActionId') &&
    hasOptionalEnum(project, 'autoMainBranchAction', ['merge', 'pr', 'disabled', 'agent-prompt']) &&
    hasOptionalEnum(project, 'autoOtherBranchAction', [
      'merge',
      'pr',
      'disabled',
      'agent-prompt',
    ]) &&
    hasOptionalString(project, 'autoMainActionId') &&
    hasOptionalString(project, 'autoOtherActionId') &&
    hasOptionalEnum(project, 'behindTargetAction', ['auto', 'rebase', 'merge'])
  );
}

function isValidActionEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const action = value as Record<string, unknown>;
  const type = action['type'];
  return (
    hasString(action, 'id') &&
    hasString(action, 'title') &&
    hasString(action, 'content') &&
    (type === undefined || type === 'prompt' || type === 'command') &&
    hasOptionalStringArray(action, 'projectIds') &&
    hasOptionalNullableNumber(action, 'lastUsedAt') &&
    hasOptionalString(action, 'lastUserInput') &&
    hasOptionalString(action, 'presetId') &&
    hasOptionalString(action, 'launchModeId') &&
    hasOptionalEnum(action, 'sshExecutionLocation', ACTION_SSH_EXECUTION_LOCATIONS) &&
    hasOptionalBoolean(action, 'background')
  );
}

function validateJsonSettingsFile(
  file: SettingsValidationFile,
  validate: (parsed: unknown) => number
): SettingsValidationResult['files'][SettingsValidationFile] {
  const filePath = join(getKomlaBasePath(), 'settings', `${file}.json`);

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { value, hadBom } = stripUtf8Bom(raw);
    const parsed: unknown = JSON.parse(value);
    const count = validate(parsed);
    return {
      ok: true,
      count,
      ...(hadBom
        ? {
            warning:
              'File starts with a UTF-8 BOM; Komla can read it, but agents should not write one.',
          }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

function validateProjectsSettings(parsed: unknown): number {
  const projects =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['projects']
      : undefined;

  if (!Array.isArray(projects)) {
    throw new Error('projects.json must contain a projects array');
  }

  const invalidIndex = projects.findIndex((project) => !isValidProjectEntry(project));
  if (invalidIndex !== -1) {
    throw new Error(`projects.json has an invalid project entry at index ${invalidIndex}`);
  }

  const duplicateIndex = findDuplicateIdIndex(projects as Array<Record<string, unknown>>);
  if (duplicateIndex !== -1) {
    throw new Error(`projects.json has a duplicate project id at index ${duplicateIndex}`);
  }

  return projects.length;
}

function validateActionsSettings(parsed: unknown): number {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('actions.json must contain an actions array');
  }

  const actions = (parsed as Record<string, unknown>)['actions'];
  if (!Array.isArray(actions)) {
    throw new Error('actions.json must contain an actions array');
  }

  const invalidIndex = actions.findIndex((action) => !isValidActionEntry(action));
  if (invalidIndex !== -1) {
    throw new Error(`actions.json has an invalid action entry at index ${invalidIndex}`);
  }

  const duplicateIndex = findDuplicateIdIndex(actions as Array<Record<string, unknown>>);
  if (duplicateIndex !== -1) {
    throw new Error(`actions.json has a duplicate action id at index ${duplicateIndex}`);
  }

  return actions.length;
}

export function handleSettingsValidationRequest(res: http.ServerResponse): void {
  const result: SettingsValidationResult = {
    ok: true,
    files: {
      projects: validateJsonSettingsFile('projects', (parsed) => validateProjectsSettings(parsed)),
      actions: validateJsonSettingsFile('actions', (parsed) => validateActionsSettings(parsed)),
    },
  };
  result.ok = Object.values(result.files).every((file) => file.ok);

  res.writeHead(result.ok ? 200 : 422, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}
