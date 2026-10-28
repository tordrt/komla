import { describe, expect, it } from 'vitest';

import {
  resolveOpenSettingsTarget,
  resolveSettingsPage,
} from '../../../src/renderer/lib/settings-navigation';

describe('resolveOpenSettingsTarget', () => {
  it('preserves existing string open-settings payloads', () => {
    expect(resolveOpenSettingsTarget('actions')).toEqual({
      tab: 'actions',
      generalSection: undefined,
    });
  });

  it('routes object payloads with tab and section', () => {
    expect(resolveOpenSettingsTarget({ tab: 'general', section: 'terminal' })).toEqual({
      tab: 'general',
      generalSection: 'terminal',
    });
  });

  it('defaults section-only payloads to the general tab', () => {
    expect(resolveOpenSettingsTarget({ section: 'terminal' })).toEqual({
      tab: 'general',
      generalSection: 'terminal',
    });
  });

  it('handles empty payloads', () => {
    expect(resolveOpenSettingsTarget(undefined)).toEqual({
      tab: undefined,
      generalSection: undefined,
    });
  });
});

describe('resolveSettingsPage', () => {
  it('passes current page ids through', () => {
    expect(resolveSettingsPage('integrations', undefined)).toBe('integrations');
    expect(resolveSettingsPage('ssh', undefined)).toBe('ssh');
  });

  it('maps the retired combined SSH & sandboxing page to SSH hosts', () => {
    expect(resolveSettingsPage('ssh-sandbox', undefined)).toBe('ssh');
  });

  it('maps the removed sandbox and Lima VM pages to SSH hosts', () => {
    expect(resolveSettingsPage('sandbox', undefined)).toBe('ssh');
    expect(resolveSettingsPage('lima-vm', undefined)).toBe('ssh');
  });

  it('routes the terminal section to the terminal page', () => {
    expect(resolveSettingsPage('general', 'terminal')).toBe('terminal');
  });

  it('routes the voice section to the voice page', () => {
    expect(resolveSettingsPage(undefined, 'voice')).toBe('voice');
  });

  it('routes other general sections to the general page', () => {
    expect(resolveSettingsPage(undefined, 'privacy')).toBe('general');
  });

  it('returns undefined without a target', () => {
    expect(resolveSettingsPage(undefined, undefined)).toBeUndefined();
  });
});
