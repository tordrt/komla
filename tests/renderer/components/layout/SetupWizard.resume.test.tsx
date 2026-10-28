/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ONBOARDING_KEY = 'komla.onboardingProjectId';

const { updateConfig, loadConfig } = vi.hoisted(() => ({
  updateConfig: vi.fn(),
  loadConfig: vi.fn(),
}));

const agentPresetsState = {
  templates: [
    {
      name: 'Some Agent',
      openCommand: 'some-agent',
      continueCommand: 'some-agent --continue',
      promptCommand: 'some-agent -p',
      launchModes: [],
    },
  ],
  loadTemplates: vi.fn(async () => {}),
  createActivePresets: vi.fn(async () => [{ id: 'preset-1' }]),
};

vi.mock('../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => agentPresetsState,
}));
vi.mock('../../../../src/renderer/stores/config.store', () => ({
  // Usage analytics were answered before, so setup ends on the Machine step.
  useConfigStore: () => ({
    config: { usageTelemetryConsentAnswered: true },
    updateConfig,
    loadConfig,
  }),
}));
vi.mock('../../../../src/renderer/components/projects/ProjectCreationForm', () => ({
  ProjectCreationForm: ({ onSuccess }: { onSuccess: (project: { id: string }) => void }) => (
    <button onClick={() => onSuccess({ id: 'project-1' })}>Create project</button>
  ),
}));
vi.mock('../../../../src/renderer/components/layout/OnboardingLaunchStep', () => ({
  OnboardingLaunchStep: ({ onFinish }: { onFinish: () => void }) => (
    <button onClick={onFinish}>Finish onboarding</button>
  ),
}));
vi.mock('../../../../src/renderer/components/layout/OnboardingZoomControl', () => ({
  OnboardingZoomControl: () => null,
}));

import { SetupWizard } from '../../../../src/renderer/components/layout/SetupWizard';

describe('SetupWizard onboarding resume', () => {
  beforeEach(() => {
    window.localStorage.clear();
    updateConfig.mockReset().mockResolvedValue({ ok: true, error: null });
    loadConfig.mockReset().mockResolvedValue(undefined);
    window.api = {
      getMcpStatus: vi.fn().mockResolvedValue({}),
      detectInstalledAgents: vi.fn().mockResolvedValue([]),
      trackAgentSelected: vi.fn(),
    } as unknown as typeof window.api;
  });

  it('remembers the project created in step one so onboarding can resume after quitting', async () => {
    render(<SetupWizard />);

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText('Choose Your AI Agent')).toBeInTheDocument();
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBe('project-1');
  });

  it('resumes at the agent step with the project from the earlier session', async () => {
    window.localStorage.setItem(ONBOARDING_KEY, 'project-1');
    const onComplete = vi.fn();
    render(<SetupWizard resumeProjectId="project-1" onComplete={onComplete} />);

    expect(await screen.findByText('Choose Your AI Agent')).toBeInTheDocument();
    expect(screen.queryByText('Add Your First Project')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Connect step.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish onboarding' }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ agentSetupComplete: true, defaultProjectId: 'project-1' })
    );
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBeNull();
  });
});
