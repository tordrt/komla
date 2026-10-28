import { describe, expect, it } from 'vitest';

import {
  ASK_FOR_STATUS_ITEM,
  SUGGEST_STATUS_ITEMS,
  buildCustomizePrompt,
} from '../../../src/shared/constants/customize-prompt';

describe('buildCustomizePrompt', () => {
  it('starts from the customize guide', () => {
    expect(buildCustomizePrompt()).toContain('Run `komla skill customize` and follow it.');
    expect(buildCustomizePrompt()).not.toContain('komla skill status-items');
  });

  it.each([ASK_FOR_STATUS_ITEM, SUGGEST_STATUS_ITEMS])(
    'reads the status bar guide before asking about status bar items',
    (ask) => {
      const prompt = buildCustomizePrompt(ask);
      expect(prompt).toContain('Run `komla skill customize` and follow it.');
      expect(prompt.indexOf('komla skill status-items')).toBeLessThan(prompt.indexOf('ask me'));
    }
  );
});
