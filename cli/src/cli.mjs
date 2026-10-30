/**
 * 命令行入口。
 *
 *   dsh-fix-attachments scan    [--session S] [--dsh-home P] [--json]
 *   dsh-fix-attachments fix     [--session S] [--apply] [--force] [--json]
 *   dsh-fix-attachments backups --session S [--json]
 *   dsh-fix-attachments restore --session S [--stamp T] [--apply] [--force] [--json]
 *
 * `fix` 默认是空跑（只报告），加 `--apply` 才写；
 * DeepSeek Harness 正在运行时拒绝写入（它内存里存着自己的 next seq，
 * 并发追加会撞号），除非明确给 `--force`。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { hasZstd } from "./zstd.mjs";
import { listSessionDirs, pickSessionFile, readSession } from "./session.mjs";
import { applyFix, BACKUP_MARK, groupTargets, listBackups, pendingFixes, restoreBackup } from "./repair.mjs";

const EXIT = { OK: 0, FAILED: 1, UNSUPPORTED_NODE: 2, REFUSED: 3 };

const USAGE = `dsh-fix-attachments —— 修「附件对象被删 → 会话永远报 transport failed」

症状：每轮都报 "DeepSeek Messages transport failed"，而且每次尝试 20–60ms 就失败、
一个 HTTP 请求都没发出去——因为历史里引用的图片附件对象被删了。

命令
  scan                        只报告（默认）
  fix [--apply]               给坏掉的会话追加一条 image/offload 事件
  backups --session <id>      列出某条会话的备份
  restore --session <id>      用备份回滚（需要 --apply）

选项
  --session <片段>            只处理目录名里含该片段的会话
  --dsh-home <路径>           DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --stamp <时间戳>            restore 时指定用哪个备份（默认最新）
  --apply                     真的写（fix/restore 不加就只空跑）
  --force                     DeepSeek Harness 在跑也允许写
  --json                      机读输出
  -h, --help                  本说明

标准流程
  退出 DeepSeek Harness
  dsh-fix-attachments scan
  dsh-fix-attachments fix --apply --session <片段>
  重新启动 DeepSeek Harness
`;

function parseArgs(argv) {
  const opts = {
    command: "scan",
    session: null,
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"),
    stamp: null,
    apply: false,
    force: false,
    json: false,
    help: false,
  };
  const commands = new Set(["scan", "fix", "backups", "restore"]);
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (commands.has(arg)) opts.command = arg;
    else if (arg === "--session") opts.session = rest.shift() ?? null;
    else if (arg === "--dsh-home") opts.dshHome = rest.shift() ?? opts.dshHome;
    else if (arg === "--stamp") opts.stamp = rest.shift() ?? null;
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`不认识的参数：${arg}`);
  }
  return opts;
}

function dshRunning() {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return /DeepSeek Harness\.exe/i.test(out);
    }
    const out = execSync("pgrep -fl 'DeepSeek Harness|dsh web' || true", { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolvePaths(opts) {
  const sessionsRoot = path.join(opts.dshHome, "sessions");
  const storeRoot = path.join(opts.dshHome, "attachments", "v1", "objects");
  if (!fs.existsSync(sessionsRoot)) throw new Error(`找不到会话目录：${sessionsRoot}`);
  if (!fs.existsSync(storeRoot)) {
    throw new Error(`找不到附件对象目录：${storeRoot}（--dsh-home 指错了？）`);
  }
  return { sessionsRoot, storeRoot };
}

function selectSessions(sessionsRoot, needle) {
  let dirs = listSessionDirs(sessionsRoot);
  if (needle) {
    const n = needle.toLowerCase();
    dirs = dirs.filter((d) => path.basename(d).toLowerCase().includes(n));
    if (dirs.length === 0) throw new Error(`没有目录名匹配 --session ${needle} 的会话`);
  }
  return dirs;
}

/** 读一条会话并算出要不要修、要修哪几处。 */
function analyse(file, storeRoot) {
  const session = readSession(file);
  const pending = session.formatSupported ? pendingFixes(session, storeRoot) : [];
  return {
    session,
    file,
    id: session.id,
    size: session.size,
    formatVersion: session.formatVersion,
    formatSupported: session.formatSupported,
    lastSeq: session.lastSeq,
    refs: session.refs.length,
    shadowedRefs: session.refs.filter((r) => session.shadowed.has(r.seq)).length,
    pending,
    targets: groupTargets(pending),
    missingIds: [...new Set(pending.map((r) => r.attachmentId))],
    torn: session.tornStart !== undefined,
  };
}

function runScan(opts, shared) {
  const files = shared.dirs.map((d) => pickSessionFile(d)).filter(Boolean);
  const rows = [];
  const unreadable = [];
  for (const file of files) {
    try {
      const row = analyse(file, shared.storeRoot);
      if (row.pending.length > 0 || opts.session) rows.push(row);
    } catch (err) {
      unreadable.push({ file, error: err.message });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      dshHome: opts.dshHome,
      scanned: files.length,
      broken: rows.map((r) => ({
        sessionId: r.id,
        file: r.file,
        bytes: r.size,
        formatVersion: r.formatVersion,
        lastSeq: r.lastSeq,
        imageRefs: r.refs,
        shadowedRefs: r.shadowedRefs,
        pending: r.pending.length,
        targets: r.targets,
        missingObjectIds: r.missingIds,
        torn: r.torn,
      })),
      unreadable,
    }, null, 2));
    return EXIT.OK;
  }

  console.log(`DSH 主目录 : ${opts.dshHome}`);
  console.log(`扫描会话   : ${files.length} 个会话日志`);
  for (const u of unreadable) console.log(`  ! 读不了 ${u.file}：${u.error}`);

  const broken = rows.filter((r) => r.pending.length > 0);
  if (broken.length === 0) {
    console.log("结论       : 没有需要修的会话");
    return EXIT.OK;
  }
  for (const row of broken) {
    console.log("");
    console.log(`* ${row.id}  ${human(row.size)}  格式 v${row.formatVersion}  最后 seq ${row.lastSeq}`);
    console.log(`  图片引用 ${row.refs} 个（其中已压缩掉 ${row.shadowedRefs}）→ 需要 offload ${row.pending.length} 处，涉及 ${row.missingIds.length} 个丢失对象`);
    for (const t of row.targets) console.log(`    seq ${t.seq}  imageIndexes ${JSON.stringify(t.imageIndexes)}`);
    if (!row.formatSupported) console.log("  ! 会话格式版本不认识，fix 会拒绝");
    if (row.torn) console.log("  ! 日志末尾有损坏帧，fix 会拒绝");
  }
  console.log("");
  console.log(`结论       : ${broken.length} 个会话需要修；要修就加 --apply（先退出 DSH）`);
  return EXIT.OK;
}

function runFix(opts, shared) {
  const running = dshRunning();
  if (opts.apply && running && !opts.force) {
    console.error("拒绝写入：DeepSeek Harness 正在运行。");
    console.error("  它内存里存着自己的 next seq，本工具追加的事件会撞号。");
    console.error("  请先退出它，再跑一次；确认没人在用目标会话时才加 --force。");
    return EXIT.REFUSED;
  }

  const files = shared.dirs.map((d) => pickSessionFile(d)).filter(Boolean);
  const results = [];
  for (const file of files) {
    let row;
    try {
      row = analyse(file, shared.storeRoot);
    } catch (err) {
      results.push({ sessionId: path.basename(path.dirname(file)), file, error: err.message });
      continue;
    }
    if (row.pending.length === 0) continue;
    const entry = {
      sessionId: row.id,
      file,
      bytes: row.size,
      lastSeq: row.lastSeq,
      pending: row.pending.length,
      targets: row.targets,
      missingObjectIds: row.missingIds,
    };
    if (opts.apply) {
      try {
        const res = applyFix(row.session, row.pending, { storeRoot: shared.storeRoot });
        Object.assign(entry, { applied: res.changed, newSeq: res.newSeq, backup: res.backup, frameBytes: res.frameBytes });
      } catch (err) {
        entry.applyError = err.message;
      }
    }
    results.push(entry);
  }

  if (opts.json) {
    console.log(JSON.stringify({ dshHome: opts.dshHome, apply: opts.apply, dshRunning: running, results }, null, 2));
    return results.some((r) => r.applyError || r.error) ? EXIT.FAILED : EXIT.OK;
  }

  if (results.length === 0) {
    console.log("没有需要修的会话");
    return EXIT.OK;
  }
  for (const r of results) {
    console.log("");
    if (r.error) {
      console.log(`! ${r.sessionId}：${r.error}`);
      continue;
    }
    console.log(`* ${r.sessionId}  ${human(r.bytes)}  最后 seq ${r.lastSeq}`);
    console.log(`  可 offload ${r.pending} 处图片出现位置，合并成 ${r.targets.length} 个目标`);
    if (r.applyError) console.log(`  ! 写入失败：${r.applyError}`);
    else if (r.applied) console.log(`  ok 已追加 image/offload seq ${r.newSeq}（+${r.frameBytes} 字节），备份 ${path.basename(r.backup)}`);
  }
  console.log("");
  if (!opts.apply) {
    console.log("空跑：没有写任何东西。退出 DeepSeek Harness 后加 --apply。");
  } else {
    console.log("写完了。请重新启动 DeepSeek Harness；重启前不要在修过的会话里发消息");
    console.log("（追加的事件要先被加载进去才生效）。");
  }
  return EXIT.OK;
}

function runBackups(opts, shared) {
  const dirs = selectSessions(shared.sessionsRoot, opts.session);
  const out = [];
  for (const dir of dirs) {
    const file = pickSessionFile(dir);
    if (!file) continue;
    out.push({ sessionId: path.basename(dir), file, backups: listBackups(file) });
  }
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return EXIT.OK;
  }
  if (out.length === 0) {
    console.log("没有匹配的会话");
    return EXIT.OK;
  }
  for (const entry of out) {
    console.log(`* ${entry.sessionId}`);
    if (entry.backups.length === 0) console.log("  （没有备份）");
    for (const b of entry.backups) console.log(`  ${b.stamp}  ${human(b.size)}  ${b.name}`);
  }
  return EXIT.OK;
}

function runRestore(opts, shared) {
  if (!opts.session) throw new Error("restore 需要 --session <片段>");
  if (!opts.apply) {
    console.error("restore 会覆盖会话日志；确认就加 --apply");
    return EXIT.REFUSED;
  }
  const running = dshRunning();
  if (running && !opts.force) {
    console.error("拒绝写入：DeepSeek Harness 正在运行（确认无风险再加 --force）");
    return EXIT.REFUSED;
  }
  const dirs = selectSessions(shared.sessionsRoot, opts.session);
  if (dirs.length !== 1) throw new Error(`--session 必须只匹配一个会话（现在匹配到 ${dirs.length} 个）`);
  const file = pickSessionFile(dirs[0]);
  if (!file) throw new Error("那个目录里没有会话日志");
  const backups = listBackups(file);
  const chosen = opts.stamp ? backups.find((b) => b.stamp === opts.stamp) : backups[0];
  if (!chosen) throw new Error(`没有找到备份（现有 ${backups.length} 个）`);

  const session = readSession(file);
  const res = restoreBackup(session, chosen.path);
  const after = readSession(file);
  const residual = after.formatSupported ? pendingFixes(after, shared.storeRoot) : [];
  console.log(`已用 ${chosen.name} 还原 ${path.basename(file)}`);
  if (res.safety) console.log(`  还原前的状态另存为 ${path.basename(res.safety)}`);
  console.log(`  日志回到 ${human(after.size)}；现在又有 ${residual.length} 处图片读不出来（等于回到修复前）`);
  return EXIT.OK;
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  if (!hasZstd()) {
    console.error(`这个 Node 没有同步 zstd API（需要 ≥ 22.15 或 ≥ 23），当前 ${process.version}`);
    return EXIT.UNSUPPORTED_NODE;
  }
  const { sessionsRoot, storeRoot } = resolvePaths(opts);
  const dirs = selectSessions(sessionsRoot, opts.session);
  const shared = { sessionsRoot, storeRoot, dirs };

  switch (opts.command) {
    case "scan":
      return runScan(opts, shared);
    case "fix":
      return runFix(opts, shared);
    case "backups":
      return runBackups(opts, shared);
    case "restore":
      return runRestore(opts, shared);
    default:
      console.error(`不认识的命令：${opts.command}`);
      return EXIT.FAILED;
  }
}

export { BACKUP_MARK };
