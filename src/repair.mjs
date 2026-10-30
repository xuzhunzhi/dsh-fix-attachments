/**
 * The actual repair: find image references whose content-addressed object is
 * gone while the message is still on the surface, then log one `image/offload`
 * event that makes the adapter send placeholder text instead of reading bytes.
 *
 * Everything here is deliberately conservative: it refuses rather than guesses,
 * and it verifies the result by re-reading the whole artifact.
 */

import fs from "node:fs";
import path from "node:path";
import { compressFrame, scanFrames } from "./zstd.mjs";
import { objectPath, readSession } from "./session.mjs";

export const BACKUP_MARK = ".bak-";

/**
 * References that are (a) on the current surface, (b) not already offloaded,
 * and (c) pointing at an attachment object that no longer exists.
 */
export function pendingFixes(session, storeRoot) {
  const pending = [];
  for (const ref of session.refs) {
    if (ref.alreadyOffloaded) continue;
    if (session.shadowed.has(ref.seq)) continue;
    if (session.offloaded.get(ref.seq)?.has(ref.imageIndex)) continue;
    if (fs.existsSync(objectPath(storeRoot, ref.attachmentId))) continue;
    pending.push(ref);
  }
  return pending;
}

/** Collapse references into `image/offload` targets, one per message. */
export function groupTargets(pending) {
  const bySeq = new Map();
  for (const ref of pending) {
    const set = bySeq.get(ref.seq) ?? new Set();
    set.add(ref.imageIndex);
    bySeq.set(ref.seq, set);
  }
  return [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, set]) => ({ seq, imageIndexes: [...set].sort((a, b) => a - b) }));
}

/** Local-time stamp used in backup names, e.g. 20261030121358. */
export function localStamp(prefix = "") {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${prefix}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Build the single event + its frame for a set of targets. */
export function buildOffloadFrame(targets, seq, now = Date.now()) {
  const event = { type: "image/offload", seq, time: now, data: { targets } };
  const payload = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  return { event, payload, frame: compressFrame(payload) };
}

/**
 * Append the repair event.
 *
 * @param session - value from readSession() that produced `pending`
 * @param pending - value from pendingFixes() for that same session
 * @returns {{changed:boolean, backup?:string, newSeq?:number, frameBytes?:number, event?:object}}
 */
export function applyFix(session, pending, { storeRoot }) {
  if (!session.formatSupported) {
    throw new Error(`unsupported session format version ${session.formatVersion}; refusing to write`);
  }
  if (session.tornStart !== undefined) {
    throw new Error(`artifact ends with a torn frame at byte ${session.tornStart}; refusing to write`);
  }
  const targets = groupTargets(pending);
  if (targets.length === 0) return { changed: false };

  // Optimistic concurrency: nothing may have appended since we read it.
  const before = fs.statSync(session.file).size;
  if (before !== session.size) {
    throw new Error("artifact changed since it was read (another writer?); re-run");
  }

  const newSeq = session.lastSeq + 1;
  const { event, frame } = buildOffloadFrame(targets, newSeq);

  const backup = `${session.file}${BACKUP_MARK}${localStamp()}`;
  fs.copyFileSync(session.file, backup);
  if (fs.statSync(backup).size !== session.size) {
    throw new Error("backup size mismatch; aborted before writing");
  }

  fs.appendFileSync(session.file, frame);
  const after = fs.statSync(session.file).size;
  if (after !== session.size + frame.length) {
    throw new Error(`unexpected artifact size after append (${after}); backup kept at ${backup}`);
  }

  // Full re-read: structure, counts, last event, and residual work.
  const again = readSession(session.file);
  if (again.tornStart !== undefined) throw new Error(`verification failed: torn frame after append (backup ${backup})`);
  if (again.frames.length !== session.frames.length + 1) throw new Error(`verification failed: frame count did not grow by one (backup ${backup})`);
  if (again.lines !== session.lines + 1) throw new Error(`verification failed: line count did not grow by one (backup ${backup})`);
  if (again.lastSeq !== newSeq) throw new Error(`verification failed: last seq is ${again.lastSeq}, expected ${newSeq} (backup ${backup})`);
  const residual = pendingFixes(again, storeRoot);
  if (residual.length !== 0) throw new Error(`verification failed: ${residual.length} reference(s) still uncovered (backup ${backup})`);

  return { changed: true, backup, newSeq, frameBytes: frame.length, event, targets };
}

/** Backups recorded next to an artifact, newest first. */
export function listBackups(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return fs.readdirSync(dir)
    .filter((n) => n.startsWith(base + BACKUP_MARK))
    .map((n) => {
      const full = path.join(dir, n);
      const st = fs.statSync(full);
      return { name: n, path: full, size: st.size, mtime: st.mtimeMs, stamp: n.slice((base + BACKUP_MARK).length) };
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/**
 * Restore an artifact from a backup. Returns the post-restore state so the
 * caller can report honestly that the session is unresolved again.
 */
export function restoreBackup(session, backupPath) {
  const backupSize = fs.statSync(backupPath).size;
  const before = fs.statSync(session.file).size;
  if (backupSize === before) return { restored: false, reason: "artifact already matches this backup" };
  const safety = `${session.file}${BACKUP_MARK}${localStamp("pre-restore-")}`;
  fs.copyFileSync(session.file, safety);
  fs.copyFileSync(backupPath, session.file);
  if (fs.statSync(session.file).size !== backupSize) throw new Error("restore failed: size mismatch");
  return { restored: true, safety, from: backupPath };
}

/** Structural health check that never writes. */
export function inspect(artifact) {
  const { frames } = scanFrames(fs.readFileSync(artifact));
  return { frames: frames.length };
}
