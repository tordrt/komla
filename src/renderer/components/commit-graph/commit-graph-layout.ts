import type { CommitGraphCommit, CommitGraphRef } from '../../../shared/types/commit-graph';

// Lane layout after VS Code's source control graph (scmHistory.ts), which Orca's follows too.

/** A `--git-graph-*` color token. */
export type CommitGraphColor =
  | 'ref'
  | 'remote-ref'
  | 'base-ref'
  | 'lane-1'
  | 'lane-2'
  | 'lane-3'
  | 'lane-4'
  | 'lane-5';

const LANE_COLORS: CommitGraphColor[] = ['lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-5'];

/** A line of history running down the graph, waiting for the commit `hash`. */
export interface CommitGraphLane {
  hash: string;
  color: CommitGraphColor;
}

export interface CommitGraphRowRef extends CommitGraphRef {
  /** Set for the checked-out branch, its upstream and the target branch. */
  color: CommitGraphColor | null;
}

export interface CommitGraphRow {
  commit: CommitGraphCommit;
  /** The lanes that enter the row from above. */
  inputLanes: CommitGraphLane[];
  /** The lanes that leave the row below. */
  outputLanes: CommitGraphLane[];
  /** Which lane the commit's dot sits in. */
  nodeLane: number;
  nodeColor: CommitGraphColor;
  refs: CommitGraphRowRef[];
}

export interface CommitGraphRefRoles {
  currentBranch: string | null;
  upstream: string | null;
  /** The branch the workspace merges into, such as `main`. */
  targetBranch: string | null;
}

function withoutRemote(name: string): string {
  return name.slice(name.indexOf('/') + 1);
}

function refColor(ref: CommitGraphRef, roles: CommitGraphRefRoles): CommitGraphColor | null {
  if (ref.kind === 'tag') return null;
  if (ref.kind === 'branch' && ref.name === roles.currentBranch) return 'ref';
  if (ref.name === roles.upstream) return 'remote-ref';
  const target = roles.targetBranch;
  if (
    target &&
    (ref.name === target || (ref.kind === 'remote' && withoutRemote(ref.name) === target))
  ) {
    return 'base-ref';
  }
  return null;
}

const COLOR_ORDER: (CommitGraphColor | null)[] = ['ref', 'remote-ref', 'base-ref'];
const KIND_ORDER: CommitGraphRef['kind'][] = ['branch', 'remote', 'tag'];

function rank(ref: CommitGraphRowRef): number {
  const byColor = COLOR_ORDER.indexOf(ref.color);
  return byColor === -1 ? COLOR_ORDER.length + KIND_ORDER.indexOf(ref.kind) : byColor;
}

/**
 * The commit's refs with their colors, the colored ones first. A remote branch on the same
 * commit as the local branch of the same name only repeats it, so it's left out.
 */
export function rowRefs(
  commit: CommitGraphCommit,
  roles: CommitGraphRefRoles
): CommitGraphRowRef[] {
  const localBranches = new Set(
    commit.refs.filter((ref) => ref.kind === 'branch').map((ref) => ref.name)
  );
  return commit.refs
    .filter((ref) => ref.kind !== 'remote' || !localBranches.has(withoutRemote(ref.name)))
    .map((ref) => ({ ...ref, color: refColor(ref, roles) }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * Assigns each commit a lane and the lanes running past it. A lane waits for one commit: the
 * commit takes the first lane waiting for it, its first parent continues that lane, and every
 * further parent starts a new lane on the right. A lane leaving the commit of the checked-out
 * branch, its upstream or the target branch takes that ref's color, so the line keeps it all
 * the way down; any other new lane takes the next lane color.
 */
export function layoutCommitGraph(
  commits: CommitGraphCommit[],
  roles: CommitGraphRefRoles
): CommitGraphRow[] {
  const refsByHash = new Map(commits.map((commit) => [commit.hash, rowRefs(commit, roles)]));
  const labelColor = (hash: string) => refsByHash.get(hash)?.find((ref) => ref.color)?.color;
  let colorIndex = -1;
  const nextLaneColor = () => {
    colorIndex = (colorIndex + 1) % LANE_COLORS.length;
    return LANE_COLORS[colorIndex];
  };

  const rows: CommitGraphRow[] = [];
  let lanes: CommitGraphLane[] = [];
  for (const commit of commits) {
    const [firstParent, ...otherParents] = commit.parentHashes;
    const ownColor = labelColor(commit.hash);
    const outputLanes: CommitGraphLane[] = [];
    let firstParentPlaced = false;
    for (const lane of lanes) {
      if (lane.hash !== commit.hash) {
        outputLanes.push(lane);
      } else if (!firstParentPlaced && firstParent) {
        outputLanes.push({ hash: firstParent, color: ownColor ?? lane.color });
        firstParentPlaced = true;
      }
    }
    if (firstParent && !firstParentPlaced) {
      outputLanes.push({ hash: firstParent, color: ownColor ?? nextLaneColor() });
    }
    for (const parent of otherParents) {
      outputLanes.push({ hash: parent, color: labelColor(parent) ?? nextLaneColor() });
    }

    const inputIndex = lanes.findIndex((lane) => lane.hash === commit.hash);
    const nodeLane = inputIndex === -1 ? lanes.length : inputIndex;
    const nodeColor =
      !firstParent && inputIndex !== -1
        ? lanes[inputIndex].color
        : (outputLanes[nodeLane]?.color ?? lanes[nodeLane]?.color ?? 'ref');
    rows.push({
      commit,
      inputLanes: lanes,
      outputLanes,
      nodeLane,
      nodeColor,
      refs: refsByHash.get(commit.hash) ?? [],
    });
    lanes = outputLanes;
  }
  return rows;
}
