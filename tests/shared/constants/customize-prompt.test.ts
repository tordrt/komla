import { describe, expect, it } from 'vitest';

import {
  ASK_FOR_PANEL,
  ASK_FOR_STATUS_ITEM,
  SUGGEST_STATUS_ITEMS,
  buildCustomizePrompt,
} from '../../../src/shared/constants/customize-prompt';

describe('buildCustomizePrompt', () => {
  it('starts from the customize guide', () => {
    expect(buildCustomizePrompt()).toContain('Run `komla skill customize` and follow it.');
    expect(buildCustomizePrompt()).not.toContain('komla skill integrations');
  });

  it.each([ASK_FOR_STATUS_ITEM, SUGGEST_STATUS_ITEMS, ASK_FOR_PANEL])(
    'reads the integrations guide before asking what to make',
    (ask) => {
      const prompt = buildCustomizePrompt(ask);
      expect(prompt).toContain('Run `komla skill customize` and follow it.');
      expect(prompt.indexOf('komla skill integrations')).toBeLessThan(prompt.indexOf('ask me'));
    }
  );
});
