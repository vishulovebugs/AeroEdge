'use strict';

/**
 * Version classification for AeroEdge (Phase 9).
 *
 * A PURE three-way comparator: given the edge side, the cloud side, and the
 * common ancestor (the last-synced fingerprint from Phase 8's sync ledger),
 * classify the relationship into EXACTLY one of four cases — no defaulting,
 * no last-write-wins:
 *
 *   CLOUD_NEWER  cloud changed since the ancestor, edge did not
 *                → the edge updates itself from cloud.
 *   EDGE_NEW     edge changed since the ancestor (or was never synced),
 *                cloud did not change independently
 *                → the observation uploads; it is NOT promoted to fleet
 *                truth — it routes through Cloud JEV in Phase 10 first.
 *   DIVERGED     BOTH sides changed since the ancestor
 *                → an open Conflict record; nothing is overwritten in
 *                either direction until resolution (Phase 10).
 *   IDENTICAL    both sides carry the same fingerprint
 *                → deduplicate: nothing to do.
 *
 * The ancestor matters: "both changed" cannot be detected by comparing two
 * versions to each other — without a base, every difference would look like
 * a conflict and last-write-wins would be the only remaining policy. The
 * base fingerprint comes from the Phase 8 ledger (what the two sides last
 * agreed on). Cloud-only-known records (never synced, cloud has content)
 * classify as CLOUD_NEWER for the edge; edge-only-new records classify as
 * EDGE_NEW.
 *
 * Pure module: no I/O, no clocks — fully deterministic and unit-testable.
 */

/**
 * The exactly-four reconciliation cases.
 * @typedef {'CLOUD_NEWER'|'EDGE_NEW'|'DIVERGED'|'IDENTICAL'} VersionCase
 */

/** @type {readonly VersionCase[]} */
export const VERSION_CASES = Object.freeze(['CLOUD_NEWER', 'EDGE_NEW', 'DIVERGED', 'IDENTICAL']);

/**
 * Classify the relationship between the edge copy, the cloud copy, and the
 * common ancestor fingerprint.
 *
 * @param {Object} input
 * @param {string} input.edgeFingerprint Current edge content fingerprint (empty string = edge has nothing).
 * @param {string} input.cloudFingerprint Current cloud content fingerprint (empty string = cloud has nothing).
 * @param {string} input.baseFingerprint Last-agreed (synced) fingerprint (empty string = never synced / no common ancestor).
 * @returns {{ kase: VersionCase, reason: string }}
 */
export function classifyVersions({ edgeFingerprint, cloudFingerprint, baseFingerprint }) {
  for (const [name, value] of Object.entries({ edgeFingerprint, cloudFingerprint, baseFingerprint })) {
    if (typeof value !== 'string') {
      throw new TypeError(`classifyVersions: "${name}" must be a string (use "" for absent)`);
    }
  }
  const edge = edgeFingerprint !== '';
  const cloud = cloudFingerprint !== '';
  const base = baseFingerprint !== '';

  if (!edge && !cloud) {
    // Nothing on either side: nothing to reconcile. Not a case the caller
    // should hit (a delta item always has an edge or cloud record), but it
    // must classify deterministically rather than throw.
    return { kase: 'IDENTICAL', reason: 'neither side has content for this memory' };
  }
  if (edge && cloud && edgeFingerprint === cloudFingerprint) {
    return { kase: 'IDENTICAL', reason: 'both sides carry the same content fingerprint (deduplicate)' };
  }
  if (!cloud) {
    // Edge-only knowledge (or cloud copy withdrawn): nothing to adopt — the
    // edge side is the live one. Upload/upload-keep, never overwrite edge.
    return { kase: 'EDGE_NEW', reason: 'cloud has no copy; the edge record is the only live version' };
  }
  if (!edge) {
    return { kase: 'CLOUD_NEWER', reason: 'the edge has no copy; cloud content is adoptable' };
  }
  if (!base) {
    // Both sides exist, differ, and were never synced through a common
    // ancestor. Content identity is unknown — treat divergence honestly
    // rather than guessing a winner (no last-write-wins).
    return { kase: 'DIVERGED', reason: 'both sides hold different content with no common ancestor on record' };
  }
  const edgeChanged = edgeFingerprint !== baseFingerprint;
  const cloudChanged = cloudFingerprint !== baseFingerprint;
  if (edgeChanged && cloudChanged) {
    return { kase: 'DIVERGED', reason: 'both edge and cloud changed the same knowledge since the last sync point' };
  }
  if (cloudChanged) {
    return { kase: 'CLOUD_NEWER', reason: 'cloud changed since the last sync point; the edge did not' };
  }
  if (edgeChanged) {
    return { kase: 'EDGE_NEW', reason: 'the edge changed since the last sync point; cloud did not' };
  }
  // edge !== cloud but both equal base is unreachable for real fingerprints;
  // classify defensively as divergence rather than silently picking a side.
  return { kase: 'DIVERGED', reason: 'inconsistent fingerprint state; refusing to pick a winner' };
}
