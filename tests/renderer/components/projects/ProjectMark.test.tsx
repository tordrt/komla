/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProjectMark } from '../../../../src/renderer/components/projects/ProjectMark';

describe('ProjectMark', () => {
  // A list of projects, some with icons, starts every name at one edge.
  it("puts a project's color dot in a box as wide as its icon would be", () => {
    const { container } = render(
      <ProjectMark project={{ color: 'red' }} iconClassName="size-4" dotClassName="size-2" />
    );

    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveClass('size-4', 'shrink-0');
    const dot = box.firstElementChild as HTMLElement;
    expect(dot).toHaveClass('size-2', 'rounded-full');
    expect(dot.style.backgroundColor).toBe('red');
  });

  it("shows a project's icon at the icon size", () => {
    const { container } = render(
      <ProjectMark project={{ icon: 'data:image/png;base64,x' }} iconClassName="size-4" />
    );

    expect(container.querySelector('img')).toHaveClass('size-4');
  });
});
