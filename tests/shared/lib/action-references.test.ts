import { describe, expect, it } from 'vitest';

import { setupStepsUsingAction } from '../../../src/shared/lib/action-references';

describe('setupStepsUsingAction', () => {
  it("lists every project's Setup steps that run the Quick Command", () => {
    const projects = [
      {
        id: 'p1',
        name: 'Komla',
        setupSteps: [
          { id: 's1', name: 'Tests', actionId: 'a1' },
          { id: 's2', name: 'Install', actionId: '' },
        ],
      },
      { id: 'p2', name: 'Site', setupSteps: [{ id: 's3', name: 'Review', actionId: 'a1' }] },
      { id: 'p3', name: 'Empty' },
    ];

    expect(setupStepsUsingAction(projects, 'a1')).toEqual([
      { project: { id: 'p1', name: 'Komla' }, step: { id: 's1', name: 'Tests' } },
      { project: { id: 'p2', name: 'Site' }, step: { id: 's3', name: 'Review' } },
    ]);
    expect(setupStepsUsingAction(projects, 'a2')).toEqual([]);
  });
});
