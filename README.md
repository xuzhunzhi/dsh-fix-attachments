# dsh-fix-attachments

> DeepSeek Harness 插件：**某条会话每轮都报 `DeepSeek Messages transport failed`** 时，自动把「读不出来的图片」降级成占位文本并让这一轮继续跑下去。

能力分类：**开发与运维** · 许可证：MIT · [English](README.en.md)

---

## 一句话价值

装之前：一条会话**永久**发不出消息，只能新开会话或手改 zstd 日志。
装之后：同一轮里自动修好并重试，用户只感觉「刚才卡了一下」，会话继续可用。

## 你是不是遇到了这个问题

对照以下几条，全中就是它：

- 某条会话**每一轮**都失败：`执行出错 · DeepSeek Messages transport failed`（code `TRANSPORT`）
- 每次尝试 **20–60 毫秒**就失败，**一个 HTTP 请求都没发出去** ← 决定性判据
- 自动退避重试 5 次（0.5s→8s）全败，这一轮就废了
- 同机、同模型，**别的会话完全正常**
- 换网络 / 代理 / key / provider 都没用
- 那条会话的历史里**读过图、传过图**

真因：附件对象是内容寻址存储的（`<DSH_HOME>/attachments/v1/objects/<sha256前2位>/<sha256>`），
对象一旦被删，请求准备阶段（`prepareImages`）每次都会重读它 → 抛 `ATTACHMENT_NOT_FOUND`
→ 被 DeepSeek Messages 适配器的兜底 `catch` 一律包成 `TRANSPORT`。**和网络无关**，重试 5 次纯属白等。

## 两种形态，同一套判定

| 形态 | 什么时候用 | 怎么跑 |
| --- | --- | --- |
| **插件（推荐）** | 平时都用它：进程内自愈，**不用重启、不用动手** | 装进 profile，见下 |
| **离线 CLI** | DSH 起不来、或想批量体检所有会话时 | `node cli/bin/dsh-fix-attachments.mjs scan` |

## 安装插件

```bash
# 发布到 npm 之后（能进 DSH 内「插件中心」一键装）
dsh plugin --profile desktop add dsh-fix-attachments

# 或者直接从源码装（未发布 npm 时用这条）
dsh plugin --profile desktop add github:xuzhunzhi/dsh-fix-attachments
```

装完重启 DSH 即可，无需其它配置。想改配置就在 profile 的 `cordis.patch.yml` 里按 entry id 覆盖：

```yaml
- id: dsh-fix-attachments
  name: 'dsh-fix-attachments'
  config:
    objectsRoot: 'D:\other-dsh-home\attachments\v1\objects'   # 可选：附件库换过位置时
    maxRepairsPerTurn: 3                                      # 可选：每轮最多修几次
```

## 插件怎么修

挂的是 agent loop 的 `agent/request-error` waterfall——和官方的上下文溢出恢复、图片预算 offload 是同一个扩展点：

1. **请求失败**时先看一眼：失败码是不是 `TRANSPORT` / `ATTACHMENT_NOT_FOUND`；
2. 是的话扫**当前视图**（`session.surface.nodes`，已被 compaction 阴影掉的老消息自动排除），
   逐个图片引用检查对象文件在不在；**已标记 offloaded 的跳过**；
3. 找到了就 `session.append('image/offload', { targets })`——这是官方既有的机制
   （官方 `compaction-image-offload` 插件在图片超预算时用的就是它），追加后适配器把这些图换成占位文本；
4. 返回 `{ kind: 'retry' }` 让这一轮**立刻重试**（这种「持久修复后的重试」不消耗 provider 重试预算，也不会记一条 `llm/retry`）；
5. 没有可修的图 → `next()`，把真网络错误原样交给下游。

两个刻意的设计：

- **不猜 cause 链**。判定依据是「视图上是否真的有读不出来的图」，而不是错误文案。所以真网络故障不会被它掩盖。
- **有收敛上界**。同一 session 同一轮最多修 `maxRepairsPerTurn` 次；而且修完那些图就变成 offloaded，下一次检查自然为空。

## 离线 CLI

```bash
node cli/bin/dsh-fix-attachments.mjs scan                 # 只报告：哪些会话坏了、要补几处
node cli/bin/dsh-fix-attachments.mjs fix --apply          # 真的写（需先退出 DSH）
node cli/bin/dsh-fix-attachments.mjs backups --session <id>       # 看备份
node cli/bin/dsh-fix-attachments.mjs restore --session <id> --apply  # 回滚
```

CLI 会逐帧解压 `session.vN.jsonl.zstd`、自己算 compaction 阴影集、追加一条带 checksum 的 `image/offload` 帧，**写前备份、写后全量复核**。它拒绝：DSH 正在运行（seq 会撞号）、日志末尾有撕裂帧、会话格式版本不认识。

## 边界（重要）

- **图片不会回来**。对象是内容寻址的，字节没了就是没了；插件只是让会话能继续说下去。
- **不修根因**。对象仍可能继续消失（实测两次：2026-10-26、2026-10-30，第二次一次少 12 个），所以要一直装着它。
- **不改 DSH 安装**：不碰 `app.asar`、不碰模型请求的其它环节，只追加**一条**持久事件。
- **只处理图片块**。其它类型附件（`file`）不参与请求准备，不需要修。
- **不冒充官方**：社区项目，与 DeepSeek AI 无隶属关系。

## 上游缺陷

这是止血。同一个缺陷已有多份重复报告，截至 `0.2.1-rc.5` 仍在：

- [#6818](https://github.com/deepseek-ai/deepseek-harness/discussions/6818) · [#7834](https://github.com/deepseek-ai/deepseek-harness/discussions/7834) · [#9262](https://github.com/deepseek-ai/deepseek-harness/discussions/9262) · [#10242](https://github.com/deepseek-ai/deepseek-harness/discussions/10242) · [#10842](https://github.com/deepseek-ai/deepseek-harness/discussions/10842)

真正的修法是让 `prepareImages` 把「存储字节取不出来」降级成占位文本，并把 `ATTACHMENT_NOT_FOUND` 原样透出而不是包成 `TRANSPORT`。
可直接粘贴的上游报告草稿见 [`docs/upstream-issue.md`](docs/upstream-issue.md)。

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH | `0.2.1-rc.5` 实测可用（`package.json` 的 `dsh.compatibility` 只声明验证过的版本） |
| Node | ≥ 22.15（CLI 用到同步 zstd API） |
| 平台 | Windows / macOS / Linux |
| 会话格式 | v4（CLI 只认这个版本，认不出就拒绝写入） |

## 开发

```bash
npm test    # node --test：15 个用例
```

覆盖：插件的「找到缺图 → 追加 offload → 要求重试」、无缺图时交给下游、非相关错误码跳过、
取消信号、每轮上限；CLI 的格式探测、compaction 阴影排除、应用、幂等、回滚、撕裂帧拒绝、空跑。

## License

MIT，见 [LICENSE](LICENSE)。按原样提供、不提供担保。
