import { useId } from 'react';

import type { CommitGraphColor, CommitGraphRow } from './commit-graph-layout';

const LANE_WIDTH = 11;
/** Rows are exactly this tall, so each row's lanes meet the next row's. */
export const COMMIT_GRAPH_ROW_HEIGHT = 24;
const NODE_Y = COMMIT_GRAPH_ROW_HEIGHT / 2;
const CORNER_RADIUS = 5;
const DOT_RADIUS = 3.5;
const MERGE_DOT_RADIUS = 4.5;
const HEAD_DOT_RADIUS = 6.5;

const laneX = (lane: number) => LANE_WIDTH * (lane + 1);
const colorVar = (color: CommitGraphColor) => `var(--git-graph-${color})`;

function lanePaths(row: CommitGraphRow): { d: string; color: CommitGraphColor }[] {
  const { commit, inputLanes, outputLanes, nodeLane, nodeColor } = row;
  const nodeX = laneX(nodeLane);
  const paths: { d: string; color: CommitGraphColor }[] = [];

  let outputIndex = 0;
  inputLanes.forEach((lane, index) => {
    const x = laneX(index);
    if (lane.hash === commit.hash) {
      if (index !== nodeLane) {
        // Another child's lane ends at this commit: it curves in from the right.
        paths.push({
          d: `M ${x} 0 A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${x - LANE_WIDTH} ${NODE_Y} H ${nodeX}`,
          color: lane.color,
        });
      } else if (commit.parentHashes.length > 0) {
        // The first parent carries the lane on.
        outputIndex += 1;
      }
      return;
    }
    if (lane.hash !== outputLanes[outputIndex]?.hash) return;
    const toX = laneX(outputIndex);
    paths.push({
      d:
        index === outputIndex
          ? `M ${x} 0 V ${COMMIT_GRAPH_ROW_HEIGHT}`
          : // A lane on its left ended here, so it moves over.
            `M ${x} 0 V ${NODE_Y - CORNER_RADIUS} A ${CORNER_RADIUS} ${CORNER_RADIUS} 0 0 1 ${x - CORNER_RADIUS} ${NODE_Y} H ${toX + CORNER_RADIUS} A ${CORNER_RADIUS} ${CORNER_RADIUS} 0 0 0 ${toX} ${NODE_Y + CORNER_RADIUS} V ${COMMIT_GRAPH_ROW_HEIGHT}`,
      color: lane.color,
    });
    outputIndex += 1;
  });

  // A merge runs from the dot out to each further parent's new lane.
  for (const parent of commit.parentHashes.slice(1)) {
    const lane = outputLanes.findLastIndex((candidate) => candidate.hash === parent);
    if (lane === -1) continue;
    const x = laneX(lane);
    paths.push({
      d: `M ${x - LANE_WIDTH} ${NODE_Y} A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${x} ${COMMIT_GRAPH_ROW_HEIGHT} M ${x - LANE_WIDTH} ${NODE_Y} H ${nodeX}`,
      color: outputLanes[lane].color,
    });
  }

  if (inputLanes[nodeLane]?.hash === commit.hash) {
    paths.push({ d: `M ${nodeX} 0 V ${NODE_Y}`, color: inputLanes[nodeLane].color });
  }
  if (commit.parentHashes.length > 0) {
    paths.push({ d: `M ${nodeX} ${NODE_Y} V ${COMMIT_GRAPH_ROW_HEIGHT}`, color: nodeColor });
  }
  return paths;
}

/**
 * One row's slice of the commit graph: the lanes running through it and the commit's dot.
 * HEAD gets a large dot set off from the lines, a merge a ring; holes are cut with a mask, so
 * they show whatever the row's background is, hovered or not.
 */
export function CommitGraphLanes({ row, isHead }: { row: CommitGraphRow; isHead: boolean }) {
  const maskId = `commit-graph-${useId().replace(/[^\w-]/g, '')}`;
  const isMerge = row.commit.parentHashes.length > 1;
  const width =
    LANE_WIDTH * (Math.max(row.inputLanes.length, row.outputLanes.length, row.nodeLane + 1, 1) + 1);
  const cx = laneX(row.nodeLane);
  const radius = isHead ? HEAD_DOT_RADIUS : isMerge ? MERGE_DOT_RADIUS : DOT_RADIUS;
  const masked = isHead || isMerge;

  return (
    <svg
      aria-hidden="true"
      width={width}
      height={COMMIT_GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${COMMIT_GRAPH_ROW_HEIGHT}`}
      // Inline, so the menu's icon sizing doesn't apply.
      style={{ width, height: COMMIT_GRAPH_ROW_HEIGHT }}
      className="shrink-0"
    >
      {masked && (
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={width}
          height={COMMIT_GRAPH_ROW_HEIGHT}
        >
          <rect width={width} height={COMMIT_GRAPH_ROW_HEIGHT} fill="white" />
          {isHead && (
            <>
              <circle cx={cx} cy={NODE_Y} r={HEAD_DOT_RADIUS + 1.5} fill="black" />
              <circle cx={cx} cy={NODE_Y} r={HEAD_DOT_RADIUS} fill="white" />
            </>
          )}
          <circle cx={cx} cy={NODE_Y} r={isHead ? 1.5 : 2} fill="black" />
        </mask>
      )}
      <g mask={masked ? `url(#${maskId})` : undefined}>
        {lanePaths(row).map(({ d, color }) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke={colorVar(color)}
            strokeWidth={1}
            strokeLinecap="round"
          />
        ))}
        <circle cx={cx} cy={NODE_Y} r={radius} fill={colorVar(row.nodeColor)} />
      </g>
    </svg>
  );
}
