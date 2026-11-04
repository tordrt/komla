function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `next`, with every part deeply equal to the same part of `prev` replaced by `prev`'s. A list
 * reloaded whole, e.g. over IPC, then keeps the identity of everything that didn't change, so
 * React subscribers to those parts don't re-render. Only plain objects and arrays are compared;
 * anything else, such as a Date or a Set, is taken from `next`.
 */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  const nextIsArray = Array.isArray(next);
  if (nextIsArray ? !Array.isArray(prev) : !(isPlainObject(prev) && isPlainObject(next))) {
    return next;
  }

  const prevRecord = prev as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const prevKeys = Object.keys(prevRecord);
  const nextKeys = Object.keys(nextRecord);
  const copy = (nextIsArray ? [] : {}) as Record<string, unknown>;
  let equal = prevKeys.length === nextKeys.length;
  for (const key of nextKeys) {
    const value = replaceEqualDeep(prevRecord[key], nextRecord[key]);
    copy[key] = value;
    if (equal && (value !== prevRecord[key] || !Object.hasOwn(prevRecord, key))) equal = false;
  }
  return (equal ? prev : copy) as T;
}
