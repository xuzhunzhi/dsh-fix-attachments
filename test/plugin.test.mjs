import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { apply, findUnreadableImages, resolveObjectsRoot } from "../index.js";

const MISSING = crypto.createHash("sha256").update("missing").digest("hex");
const PRESENT = crypto.createHash("sha256").update("present").digest("hex");
const SHADOWED_MISSING = crypto.createHash("sha256").update("shadowed-missing").digest("hex");

/** 造一个最小附件库：PRESENT 存在，其余不存在。 */
function objectsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-fix-plugin-"));
  const file = path.join(root, PRESENT.slice(0, 2), PRESENT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "bytes");
  return root;
}

function imageBlock(id, offloaded = false) {
  return {
    type: "image",
    attachment: { attachmentId: `sha256:${id}`, mediaType: "image/jpeg", bytes: 1, width: 1, height: 1 },
    ...(offloaded ? { offloaded: true } : {}),
  };
}

/** 一个只有 seq 1..3 视图的假 session：1 缺图、2 有图、3 已 offloaded。 */
function fakeSession({ withMissing = true } = {}) {
  const events = new Map([
    [1, { type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text: "shot" }, imageBlock(withMissing ? MISSING : PRESENT)] } } }],
    [2, { type: "tool/result", data: { message: { role: "tool", content: [imageBlock(PRESENT)] } } }],
    [3, { type: "tool/result", data: { message: { role: "tool", content: [imageBlock(MISSING, true)] } } }],
  ]);
  const appended = [];
  return {
    appended,
    session: {
      // 故意多放一个不在视图里的 seq（99，缺图）：它不该被当成目标
      surface: { nodes: [1, 2, 3] },
      eventAt: (seq) => events.get(seq),
      deriveEventMessage: (event) => event.data.message,
      append: (type, data) => {
        appended.push({ type, data });
      },
    },
  };
}

function fakeCtx() {
  const listeners = new Map();
  const logs = [];
  return {
    listeners,
    logs,
    ctx: {
      sessions: { registerMessageProjection: () => {} },
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      on: (type, handler) => listeners.set(type, handler),
    },
  };
}

const payload = (session, overrides = {}) => ({
  agent: { session },
  turn: 1,
  step: 1,
  provider: "deepseek-account",
  failure: { code: "TRANSPORT", message: "DeepSeek Messages transport failed" },
  signal: { aborted: false },
  ...overrides,
});

test("resolveObjectsRoot honours config, then DSH_HOME", () => {
  assert.equal(resolveObjectsRoot({ objectsRoot: "/tmp/x" }), "/tmp/x");
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(os.tmpdir(), "dshhome");
  try {
    assert.equal(resolveObjectsRoot({}), path.join(os.tmpdir(), "dshhome", "attachments", "v1", "objects"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("finds only unreadable images on the surface, skipping offloaded ones", () => {
  const root = objectsRoot();
  const { session } = fakeSession();
  const { targets, unreadable } = findUnreadableImages(session, root);
  assert.equal(unreadable, 1);
  assert.deepEqual(targets, [{ seq: 1, imageIndexes: [0] }]);
});

test("repairs the request from the error waterfall and asks for one retry", async () => {
  const root = objectsRoot();
  const { ctx, listeners, logs } = fakeCtx();
  apply(ctx, { objectsRoot: root });

  const handler = listeners.get("agent/request-error");
  assert.equal(typeof handler, "function");

  const { session, appended } = fakeSession();
  let nextCalls = 0;
  const action = await handler(payload(session), async () => {
    nextCalls += 1;
    return { kind: "stop" };
  });

  assert.deepEqual(action, { kind: "retry" }, "a durable repair must ask for a retry");
  assert.equal(nextCalls, 0, "the waterfall must not be delegated when we repaired");
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, "image/offload");
  assert.deepEqual(appended[0].data.targets, [{ seq: 1, imageIndexes: [0] }]);
  assert.match(logs[0] ?? "", /1 unreadable image/);
});

test("delegates when nothing is unreadable (so real network errors still surface)", async () => {
  const root = objectsRoot();
  const { ctx, listeners } = fakeCtx();
  apply(ctx, { objectsRoot: root });

  const { session, appended } = fakeSession({ withMissing: false });
  let nextCalls = 0;
  const action = await listeners.get("agent/request-error")(payload(session), async () => {
    nextCalls += 1;
    return { kind: "stop" };
  });

  assert.deepEqual(action, { kind: "stop" });
  assert.equal(nextCalls, 1);
  assert.equal(appended.length, 0);
});

test("ignores failures whose code is not attachment-related", async () => {
  const root = objectsRoot();
  const { ctx, listeners } = fakeCtx();
  apply(ctx, { objectsRoot: root });

  const { session, appended } = fakeSession();
  let nextCalls = 0;
  await listeners.get("agent/request-error")(
    payload(session, { failure: { code: "RATE_LIMIT", message: "slow down" } }),
    async () => {
      nextCalls += 1;
      return { kind: "stop" };
    },
  );

  assert.equal(nextCalls, 1);
  assert.equal(appended.length, 0);
});

test("respects an aborted signal", async () => {
  const root = objectsRoot();
  const { ctx, listeners } = fakeCtx();
  apply(ctx, { objectsRoot: root });

  const { session, appended } = fakeSession();
  let nextCalls = 0;
  await listeners.get("agent/request-error")(payload(session, { signal: { aborted: true } }), async () => {
    nextCalls += 1;
    return { kind: "stop" };
  });

  assert.equal(nextCalls, 1);
  assert.equal(appended.length, 0);
});

test("caps repairs per turn so a broken artifact cannot loop forever", async () => {
  const root = objectsRoot();
  const { ctx, listeners } = fakeCtx();
  apply(ctx, { objectsRoot: root, maxRepairsPerTurn: 2 });

  const handler = listeners.get("agent/request-error");
  const { session, appended } = fakeSession();
  // 假 session 的 append 不会真的改变视图，所以每次调用都会「又想修」。
  let nextCalls = 0;
  const next = async () => {
    nextCalls += 1;
    return { kind: "stop" };
  };

  const first = await handler(payload(session), next);
  const second = await handler(payload(session), next);
  const third = await handler(payload(session), next);

  assert.deepEqual(first, { kind: "retry" });
  assert.deepEqual(second, { kind: "retry" });
  assert.deepEqual(third, { kind: "stop" }, "the cap must delegate instead of retrying forever");
  assert.equal(appended.length, 2);
  assert.equal(nextCalls, 1);
});
