import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildFixture,
  frameCount,
  load,
  MISSING_ID,
  MISSING_SHADOWED_ID,
} from "../test-support/fixture.mjs";
import { readSession } from "../src/session.mjs";
import { applyFix, listBackups, pendingFixes, restoreBackup } from "../src/repair.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "bin", "dsh-fix-attachments.mjs");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-fixture-"));
}

test("reads a v4 artifact and hides shadowed nodes", () => {
  const fx = buildFixture(tmpRoot());
  const session = load(fx.artifact);

  assert.equal(session.formatVersion, 4);
  assert.equal(session.formatSupported, true);
  assert.equal(session.lastSeq, 7);
  assert.equal(session.frames.length, 8);
  assert.equal(session.refs.length, 3);
  assert.ok(session.shadowed.has(6), "seq 6 must be shadowed");
  assert.equal(session.tornStart, undefined);
});

test("finds only the surface image whose object is gone", () => {
  const fx = buildFixture(tmpRoot());
  const session = load(fx.artifact);
  const pending = pendingFixes(session, fx.objects);

  assert.equal(pending.length, 1, "only seq 3 qualifies");
  assert.equal(pending[0].seq, 3);
  assert.equal(pending[0].imageIndex, 0);
  assert.equal(pending[0].attachmentId, MISSING_ID);
  assert.notEqual(pending[0].attachmentId, MISSING_SHADOWED_ID);
});

test("applies the repair, verifies it, and is idempotent", () => {
  const fx = buildFixture(tmpRoot());
  const before = fs.statSync(fx.artifact).size;
  const session = load(fx.artifact);
  const pending = pendingFixes(session, fx.objects);

  const result = applyFix(session, pending, { storeRoot: fx.objects });
  assert.equal(result.changed, true);
  assert.equal(result.newSeq, 8);
  assert.ok(fs.existsSync(result.backup), "backup must exist");
  assert.equal(fs.statSync(result.backup).size, before);
  assert.equal(frameCount(fx.artifact), session.frames.length + 1);

  const after = load(fx.artifact);
  assert.equal(after.lastSeq, 8);
  assert.equal(pendingFixes(after, fx.objects).length, 0, "nothing left to repair");

  // The appended event must carry exactly the one target.
  const offloaded = after.offloaded.get(3);
  assert.ok(offloaded && offloaded.has(0), "seq 3 image 0 must be offloaded");

  // Idempotent: nothing pending, so nothing is written.
  const second = applyFix(after, pendingFixes(after, fx.objects), { storeRoot: fx.objects });
  assert.equal(second.changed, false);
  assert.equal(frameCount(fx.artifact), session.frames.length + 1);
});

test("restores from backup and reports the session as unresolved again", () => {
  const fx = buildFixture(tmpRoot());
  const original = fs.statSync(fx.artifact).size;
  const session = load(fx.artifact);
  applyFix(session, pendingFixes(session, fx.objects), { storeRoot: fx.objects });

  const backups = listBackups(fx.artifact);
  assert.equal(backups.length, 1);

  const current = load(fx.artifact);
  restoreBackup(current, backups[0].path);

  const restored = load(fx.artifact);
  assert.equal(fs.statSync(fx.artifact).size, original);
  assert.equal(restored.lastSeq, 7);
  assert.equal(pendingFixes(restored, fx.objects).length, 1);
});

test("refuses an artifact with a torn final frame", () => {
  const fx = buildFixture(tmpRoot());
  fs.appendFileSync(fx.artifact, Buffer.from([0x28, 0xb5, 0x2f]));

  const session = load(fx.artifact);
  assert.notEqual(session.tornStart, undefined);
  assert.throws(
    () => applyFix(session, [{ seq: 3, imageIndex: 0, attachmentId: MISSING_ID }], { storeRoot: fx.objects }),
    /torn frame/,
  );
});

test("refuses an unknown session format version", () => {
  const fx = buildFixture(tmpRoot(), { formatVersion: 9 });
  const session = load(fx.artifact);
  assert.equal(session.formatSupported, false);
  assert.throws(
    () => applyFix(session, [{ seq: 3, imageIndex: 0, attachmentId: MISSING_ID }], { storeRoot: fx.objects }),
    /unsupported session format/,
  );
});

test("cli scan reports the broken session without writing", () => {
  const fx = buildFixture(tmpRoot());
  const before = fs.statSync(fx.artifact).size;
  const out = execFileSync(process.execPath, [cli, "scan", "--dsh-home", fx.root], { encoding: "utf8" });

  assert.match(out, /需要修/);
  assert.match(out, /seq 3/);
  assert.equal(fs.statSync(fx.artifact).size, before, "scan must not write");
  assert.equal(listBackups(fx.artifact).length, 0);
});

test("cli fix without --apply stays a dry run", () => {
  const fx = buildFixture(tmpRoot());
  const before = fs.statSync(fx.artifact).size;
  const out = execFileSync(process.execPath, [cli, "fix", "--dsh-home", fx.root], { encoding: "utf8" });

  assert.match(out, /空跑/);
  assert.equal(fs.statSync(fx.artifact).size, before);
});
