/**
 * Build a tiny synthetic DSH home so the repair can be tested end to end
 * without touching a real profile.
 *
 * Layout mirrors the real one:
 *   <root>/sessions/<workspace>/<session>/session.v4.jsonl.zstd
 *   <root>/attachments/v1/objects/<first2>/<sha256>
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compressFrame, scanFrames } from "../cli/src/zstd.mjs";
import { readSession } from "../cli/src/session.mjs";

export const MISSING_ID = crypto.createHash("sha256").update("missing-image").digest("hex");
export const MISSING_SHADOWED_ID = crypto.createHash("sha256").update("missing-image-shadowed").digest("hex");
export const PRESENT_ID = crypto.createHash("sha256").update("present-image").digest("hex");

const file = (p) => p.replace(/\\/g, "/");

/** One event per frame, exactly like the real writer. */
export function writeArtifact(artifactPath, events) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const chunks = events.map((e) => compressFrame(Buffer.from(`${JSON.stringify(e)}\n`, "utf8")));
  fs.writeFileSync(artifactPath, Buffer.concat(chunks));
}

export function imageBlock(attachmentId) {
  return {
    type: "image",
    attachment: {
      attachmentId: `sha256:${attachmentId}`,
      mediaType: "image/jpeg",
      bytes: 1234,
      width: 64,
      height: 64,
      name: "shot.jpg",
    },
  };
}

/** The canonical fixture: one surface image missing, one present, one shadowed. */
export function buildFixture(root, { formatVersion = 4 } = {}) {
  const sessionDir = path.join(root, "sessions", "ws", "session-fixture-0001");
  const artifact = path.join(sessionDir, "session.v4.jsonl.zstd");
  const objects = path.join(root, "attachments", "v1", "objects");
  fs.mkdirSync(objects, { recursive: true });

  writeArtifact(artifact, [
    { type: "session", version: formatVersion, id: "session-fixture-0001", cwd: file(root) },
    { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 2,
      time: 2,
      data: { role: "user", content: [{ type: "text", text: "look at this" }] },
    },
    {
      type: "tool/result",
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: { role: "tool", toolCallId: "c1", content: [imageBlock(MISSING_ID)] },
      },
    },
    {
      type: "tool/result",
      seq: 4,
      time: 4,
      data: {
        turn: 1,
        step: 2,
        message: { role: "tool", toolCallId: "c2", content: [imageBlock(PRESENT_ID)] },
      },
    },
    {
      type: "compaction/summary",
      seq: 5,
      time: 5,
      data: { compactionId: "c", summary: [{ type: "text", text: "earlier turns" }], shadowedSeqs: [6] },
    },
    {
      type: "tool/result",
      seq: 6,
      time: 6,
      data: {
        turn: 1,
        step: 3,
        message: { role: "tool", toolCallId: "c3", content: [imageBlock(MISSING_SHADOWED_ID)] },
      },
    },
    { type: "turn/end", seq: 7, time: 7, data: { turn: 1, reason: { kind: "completed" } } },
  ]);

  const presentPath = path.join(objects, PRESENT_ID.slice(0, 2), PRESENT_ID);
  fs.mkdirSync(path.dirname(presentPath), { recursive: true });
  fs.writeFileSync(presentPath, Buffer.from("pretend these are jpeg bytes"));

  return { root, sessionDir, artifact, objects };
}

/** Assert every frame still parses (used by tests after a write). */
export function frameCount(artifact) {
  const { frames, tornStart } = scanFrames(fs.readFileSync(artifact));
  if (tornStart !== undefined) throw new Error("torn frame");
  return frames.length;
}

/** Convenience: reload the fixture artifact. */
export function load(artifact) {
  return readSession(artifact);
}
