/**
 * F1 live timing delta merge.
 *
 * The rules below were checked by replaying every update of all 33 topics of
 * the 2026 Singapore Grand Prix archive and comparing the result with F1's own
 * final keyframes:
 *
 * - Objects merge key by key, recursively.
 * - A JSON array in a patch replaces whatever was there.
 * - An object patch applied to an array updates items by index; an index one
 *   past the end appends.
 * - `_deleted: string[]` removes those keys from the object it appears in.
 * - `_kf` (keyframe marker) is never stored.
 *
 * The merge never mutates its inputs. Branches a patch does not touch keep
 * their identity, so consumers can compare references to find what changed.
 */

type JsonObject = Record<string, unknown>;

const KEYFRAME = '_kf';
const DELETED = '_deleted';

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a topic update is a full keyframe (`_kf: true`) rather than a delta. */
export function isKeyframe(data: unknown): boolean {
  return isPlainObject(data) && data[KEYFRAME] === true;
}

/** Remove `_kf` markers from a value, recursively. */
export function stripKeyframeMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripKeyframeMarkers);
  if (!isPlainObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== KEYFRAME) out[key] = stripKeyframeMarkers(child);
  }
  return out;
}

/** Merge a patch into a value and return the new value. */
export function applyPatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  if (Array.isArray(target)) return patchArray(target, patch);
  return patchObject(isPlainObject(target) ? target : undefined, patch);
}

/**
 * Apply one topic update to the topic's current state: a keyframe replaces
 * the state, anything else is merged into it.
 */
export function applyUpdate(state: unknown, data: unknown): unknown {
  return isKeyframe(data) ? stripKeyframeMarkers(data) : applyPatch(state, data);
}

function patchObject(target: JsonObject | undefined, patch: JsonObject): JsonObject {
  const out: JsonObject = { ...target };
  const deleted = patch[DELETED];
  if (deleted !== undefined) {
    if (!Array.isArray(deleted)) throw new TypeError('_deleted is not an array.');
    for (const key of deleted) {
      if (typeof key !== 'string') throw new TypeError('_deleted expected a string key.');
      delete out[key];
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === KEYFRAME || key === DELETED) continue;
    out[key] = applyPatch(out[key], value);
  }
  return out;
}

function patchArray(target: readonly unknown[], patch: JsonObject): unknown[] {
  const out = target.slice();
  for (const [key, value] of Object.entries(patch)) {
    if (key === KEYFRAME || key === DELETED) continue;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      throw new TypeError(`Array patch has a non-index key: ${key}`);
    }
    out[index] = applyPatch(out[index], value);
  }
  return out;
}
