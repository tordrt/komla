import { describe, expect, it } from 'vitest';

import { ansiSegments } from '../../../src/main/lib/ansi-colors';

describe('ansiSegments', () => {
  it('splits text by color, as theme colors for the basic eight', () => {
    expect(ansiSegments('\u001b[31mfail\u001b[39m and \u001b[92mpass\u001b[0m')).toEqual([
      { text: 'fail', color: 'error' },
      { text: ' and ' },
      { text: 'pass', color: 'success' },
    ]);
  });

  it('reads 256 colors and true colors as hex', () => {
    expect(ansiSegments('\u001b[38;5;208ma\u001b[38;2;229;192;123mb\u001b[38;5;244mc')).toEqual([
      { text: 'a', color: '#ff8700' },
      { text: 'b', color: '#e5c07b' },
      { text: 'c', color: '#808080' },
    ]);
  });

  it('keeps bold, and drops backgrounds and other escapes', () => {
    expect(
      ansiSegments(
        '\u001b[1;48;5;1mbold\u001b[22m \u001b]8;;https://x\u0007link\u001b]8;;\u0007\u001b[K'
      )
    ).toEqual([{ text: 'bold', bold: true }, { text: ' link' }]);
  });

  it('skips underline colors past their arguments, and colors cut short', () => {
    expect(ansiSegments('\u001b[58;5;1ma\u001b[58;2;31;0;0mb\u001b[38;5mc\u001b[38;2;1md')).toEqual(
      [{ text: 'abcd' }]
    );
  });

  it('reads colors with their arguments after colons', () => {
    expect(ansiSegments('\u001b[38:2::229:192:123ma\u001b[38:5:208mb\u001b[4:3mc')).toEqual([
      { text: 'a', color: '#e5c07b' },
      { text: 'bc', color: '#ff8700' },
    ]);
  });
});
