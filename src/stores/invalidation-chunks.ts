/** Largest invalidation message, in characters, that a tiered store publishes in one piece. */
export const MAX_PUBLISH_CHARS = 262_144;

/**
 * Splits `keys` into consecutive `{ origin, keys }` messages whose JSON is at most `maxChars`
 * long. A key that alone exceeds the limit gets a chunk of its own. Sizes are summed per key
 * (`JSON.stringify(key).length` plus a comma) over the envelope, never re-stringified per chunk.
 */
export function chunkKeys(
  origin: string,
  keys: readonly string[],
  maxChars: number,
): { origin: string; keys: string[] }[] {
  const envelope = JSON.stringify({ origin, keys: [] }).length;
  const chunks: { origin: string; keys: string[] }[] = [];
  let current: string[] = [];
  let size = envelope;
  for (const key of keys) {
    const cost = JSON.stringify(key).length + 1;
    if (current.length > 0 && size + cost > maxChars) {
      chunks.push({ origin, keys: current });
      current = [];
      size = envelope;
    }
    current.push(key);
    size += cost;
  }
  if (current.length > 0) chunks.push({ origin, keys: current });
  return chunks;
}
