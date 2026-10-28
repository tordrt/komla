import { describe, it, expect } from 'vitest';

import { parseChangelog } from '../../../src/renderer/lib/parse-changelog';

describe('parseChangelog', () => {
  it('should parse a single version with multiple sections', () => {
    const md = `# Changelog

## [1.0.0] - 2026-01-15

### Added

- Feature A
- Feature B

### Fixed

- Bug fix one
`;
    const result = parseChangelog(md);

    expect(result).toHaveLength(1);
    expect(result[0].version).toBe('1.0.0');
    expect(result[0].date).toBe('2026-01-15');
    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0]).toEqual({
      category: 'Added',
      items: ['Feature A', 'Feature B'],
    });
    expect(result[0].sections[1]).toEqual({
      category: 'Fixed',
      items: ['Bug fix one'],
    });
  });

  it('should parse multiple versions', () => {
    const md = `## [2.0.0] - 2026-02-01

### Changed

- Breaking change

## [1.0.0] - 2026-01-01

### Added

- Initial release
`;
    const result = parseChangelog(md);

    expect(result).toHaveLength(2);
    expect(result[0].version).toBe('2.0.0');
    expect(result[0].date).toBe('2026-02-01');
    expect(result[1].version).toBe('1.0.0');
    expect(result[1].date).toBe('2026-01-01');
  });

  it('should handle missing date', () => {
    const md = `## [Unreleased]

### Added

- Work in progress
`;
    const result = parseChangelog(md);

    expect(result).toHaveLength(1);
    expect(result[0].version).toBe('Unreleased');
    expect(result[0].date).toBeNull();
    expect(result[0].sections[0].items).toEqual(['Work in progress']);
  });

  it('should return empty array for non-changelog input', () => {
    const result = parseChangelog('Just some random text\nwith no changelog format');

    expect(result).toEqual([]);
  });

  it('should return empty array for empty string', () => {
    expect(parseChangelog('')).toEqual([]);
  });

  it('should handle items with asterisk bullets', () => {
    const md = `## [1.0.0] - 2026-01-01

### Added

* Item with asterisk
- Item with dash
`;
    const result = parseChangelog(md);

    expect(result[0].sections[0].items).toEqual(['Item with asterisk', 'Item with dash']);
  });

  it('should ignore items before any category heading', () => {
    const md = `## [1.0.0] - 2026-01-01

- Orphan item with no category

### Added

- Proper item
`;
    const result = parseChangelog(md);

    expect(result[0].sections).toHaveLength(1);
    expect(result[0].sections[0].items).toEqual(['Proper item']);
  });
});
