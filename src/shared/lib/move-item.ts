/**
 * Move an array item to a new position, clamping the target into range.
 * Returns the same array reference when the move is a no-op so callers can
 * cheaply detect "nothing changed".
 */
export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= items.length) return items;

  const targetIndex = Math.max(0, Math.min(toIndex, items.length - 1));
  if (fromIndex === targetIndex) return items;

  const reordered = [...items];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  return reordered;
}
