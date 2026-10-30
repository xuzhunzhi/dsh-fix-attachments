/**
 * dsh-fix-attachments —— 宿主半侧插件。
 *
 * 治什么：会话历史里引用的图片附件对象一旦被删，每次请求在准备阶段都会重读它，
 * 抛 ATTACHMENT_NOT_FOUND，被 llm-deepseek 适配器的兜底 catch 包成 TRANSPORT
 * （界面上就是「DeepSeek Messages transport failed」）。结果是这条会话永远发不出消息。
 *
 * 怎么治：挂在 `agent/request-error` waterfall 上。请求失败时先看**当前视图**里
 * 有没有引用了不存在对象的图片；有就追加一条 `image/offload`（社区/官方都在用的
 * 既有机能），让适配器把它们换成占位文本，然后请求重试一次。整个过程在进程内完成，
 * seq 由 session 分配，不存在和正在运行的实例撞号的问题。
 *
 * 为什么这样判定：不看失败文案、也不看 cause 链——只问「视图上有没有读不出来的图」。
 * 没有就一律 `next()`，把真网络错误原样交给下游；有就直接修，因为再重试多少次都失败。
 *
 * 循环保护：同一 session 的同一轮最多修 MAX_REPAIRS_PER_TURN 次。修完那些图就被标成
 * offloaded，下一轮检查自然为空，不需要额外的收敛判断。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "dsh-fix-attachments";
export const inject = ["agents", "sessions"];

/** 默认最多每轮修几次（防止某个坏事件反复触发）。 */
const DEFAULT_MAX_REPAIRS_PER_TURN = 3;

/** 只有这些失败码才值得看一眼；其它失败直接交给下游。 */
const CANDIDATE_CODES = new Set(["TRANSPORT", "ATTACHMENT_NOT_FOUND"]);

/**
 * 与核心 `compaction-image-offload` 同形的投影定义。
 *
 * 正常情况下核心已经注册过这个类型（我们的追加依赖它才生效）。这里带一份是为了
 * 核心没装/被禁用时也能自洽；注册重复会抛错，吞掉即可——两种情况的投影结果一致。
 */
const IMAGE_OFFLOAD_PROJECTION = {
  type: "image/offload",
  project(event, context) {
    const data = event?.data;
    if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data.targets) || data.targets.length === 0) {
      throw new Error("image/offload: data must contain a nonempty targets array");
    }
    const projected = new Map();
    const nodes = new Set(context.nodes);
    for (const target of data.targets) {
      if (!isRecord(target) || Object.keys(target).length !== 2) {
        throw new Error("image/offload: each target must contain a seq and imageIndexes");
      }
      const seq = target.seq;
      const indexes = target.imageIndexes;
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("image/offload: target seq must be a non-negative safe integer");
      if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`);
      if (!Array.isArray(indexes) || indexes.length === 0) throw new Error("image/offload: each target needs a nonempty imageIndexes");
      const source = context.events[seq - context.baseSeq];
      if (source?.type !== "user/message" && source?.type !== "tool/result") {
        throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`);
      }
      const message = context.messages.get(seq) ?? (source.type === "user/message" ? source.data : source.data.message);
      projected.set(seq, offloadMessageImages(message, indexes));
    }
    return projected;
  },
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function offloadMessageImages(message, indexes) {
  let imageIndex = 0;
  let selected = 0;
  const visit = (blocks) => {
    let next;
    for (const [index, block] of blocks.entries()) {
      let projected = block;
      if (block?.type === "image") {
        if (imageIndex === indexes[selected]) {
          if (block.offloaded === true) throw new Error(`image/offload: image index ${imageIndex} is already offloaded`);
          projected = { ...block, offloaded: true };
          selected += 1;
        }
        imageIndex += 1;
      }
      if (projected !== block) next ??= blocks.slice(0, index);
      next?.push(projected);
    }
    return next ?? blocks;
  };
  const content = visit(message?.content ?? []);
  if (selected !== indexes.length) throw new Error(`image/offload: image index ${indexes[selected]} does not exist`);
  return { ...message, content };
}

/** 附件对象根目录：优先配置，其次 $DSH_HOME，最后 ~/.dsh。 */
export function resolveObjectsRoot(config = {}) {
  if (typeof config.objectsRoot === "string" && config.objectsRoot.length > 0) return config.objectsRoot;
  return path.join(resolveDshHome(), "attachments", "v1", "objects");
}

/** DSH 主目录：$DSH_HOME 优先，其次 ~/.dsh。 */
export function resolveDshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), ".dsh");
}

/** 留痕文件：证明插件挂上了、修过几次（排查"为什么没生效"第一眼看这里）。 */
export function resolveStatePath(config = {}) {
  if (typeof config.statePath === "string" && config.statePath.length > 0) return config.statePath;
  return path.join(resolveDshHome(), "storages", "dsh-fix-attachments-state.json");
}

/**
 * 重写留痕文件。只写小的固定结构；任何失败都吞掉——诊断绝不能影响主流程。
 */
function writeState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // 留痕尽力而为
  }
}

/**
 * 扫当前视图，收集「对象已经不存在」的图片出现位置。
 *
 * 只看 `session.surface.nodes`：被 compaction 阴影掉的老消息不在请求里，也不该当目标。
 * 已 offloaded 的块跳过（它们不会再被读）。
 *
 * @returns {{targets: Array<{seq: number, imageIndexes: number[]}>, unreadable: number}}
 */
export function findUnreadableImages(session, objectsRoot) {
  const nodes = session?.surface?.nodes ?? [];
  const bySeq = new Map();
  let unreadable = 0;

  for (const seq of nodes) {
    const event = session?.eventAt?.(seq);
    if (!event) continue;
    if (event.type !== "user/message" && event.type !== "tool/result") continue;

    let message;
    try {
      message = session.deriveEventMessage(event);
    } catch {
      continue;
    }

    let imageIndex = 0;
    for (const block of message?.content ?? []) {
      if (!block || block.type !== "image") continue;
      if (block.offloaded !== true) {
        const id = String(block?.attachment?.attachmentId ?? "").replace(/^sha256:/, "");
        if (id.length === 64 && !fs.existsSync(path.join(objectsRoot, id.slice(0, 2), id))) {
          const set = bySeq.get(seq) ?? new Set();
          set.add(imageIndex);
          bySeq.set(seq, set);
          unreadable += 1;
        }
      }
      imageIndex += 1;
    }
  }

  const targets = [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, set]) => ({ seq, imageIndexes: [...set].sort((a, b) => a - b) }));
  return { targets, unreadable };
}

/**
 * 挂载：一个 `agent/request-error` 监听器。
 *
 * @param ctx - cordis 插件上下文（需要 `sessions` 服务才能注册投影）。
 * @param config - 可选 `{ objectsRoot?, maxRepairsPerTurn? }`。
 */
export function apply(ctx, config = {}) {
  const objectsRoot = resolveObjectsRoot(config);
  const maxRepairsPerTurn = Number.isSafeInteger(config.maxRepairsPerTurn) && config.maxRepairsPerTurn > 0
    ? config.maxRepairsPerTurn
    : DEFAULT_MAX_REPAIRS_PER_TURN;

  try {
    ctx.sessions?.registerMessageProjection?.(IMAGE_OFFLOAD_PROJECTION);
  } catch {
    // 核心已经注册过同类型投影：我们的追加照样生效，忽略。
  }

  // 留痕：挂载即写一次，之后的每次修复更新计数。排查"为什么没生效"先看它。
  const statePath = resolveStatePath(config);
  const state = {
    version: 1,
    mountedAt: new Date().toISOString(),
    objectsRoot,
    maxRepairsPerTurn,
    repairs: 0,
    lastRepair: null,
  };
  writeState(statePath, state);

  /** session -> { turn, count } */
  const repairs = new WeakMap();

  const listener = async ({ agent, turn, failure, signal }, next) => {
    const session = agent?.session;
    if (session === undefined || signal?.aborted) return next();
    if (!CANDIDATE_CODES.has(failure?.code)) return next();

    const record = repairs.get(session);
    const used = record !== undefined && record.turn === turn ? record.count : 0;
    if (used >= maxRepairsPerTurn) return next();

    const { targets, unreadable } = findUnreadableImages(session, objectsRoot);
    if (targets.length === 0) return next();

    try {
      session.append("image/offload", { targets });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`dsh-fix-attachments: could not record the offload decision: ${message}`);
      return next();
    }

    // 持久化屏障：append 只是写进内存会话，确认（ack）不等于落盘。
    // 官方口径是"需要屏障的消费者 await ctx.sessions.flush(session)"。做不到也不影响
    // 这一轮的重试（内存里已经有这条事件了），所以失败只记一条告警。
    try {
      await ctx.sessions?.flush?.(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`dsh-fix-attachments: offload decision is in memory but not flushed: ${message}`);
    }

    repairs.set(session, { turn, count: used + 1 });
    state.repairs += 1;
    state.lastRepair = { at: new Date().toISOString(), turn, targets };
    writeState(statePath, state);
    ctx.logger?.info?.(
      `dsh-fix-attachments: ${unreadable} unreadable image occurrence(s) in ${targets.length} message(s) marked as offloaded; retrying the request`,
    );
    return { kind: "retry" };
  };

  ctx.on("agent/request-error", listener);
}
