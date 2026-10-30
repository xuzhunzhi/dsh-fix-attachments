# dsh-fix-attachments

> 修「DeepSeek Harness 某条会话**永远**报 `DeepSeek Messages transport failed`」——因为它引用的**图片附件对象被删了**。

English: [README.en.md](README.en.md)

---

## 一、你是不是遇到了这个

对照这几条，全中就是它：

- 某条会话**每一轮**都失败，提示 `执行出错 · DeepSeek Messages transport failed`（code `TRANSPORT`）
- 每次尝试 **20–60 毫秒**就失败，**一个 HTTP 请求都没发出去** ← 决定性判据
- 自动退避重试 5 次（0.5s→8s），全败，这一轮就废了
- 同一台机器、同一个模型，**别的会话完全正常**
- 换网络 / 换代理 / 换 key / 换 provider 都没用
- 那条会话的历史里**读过图、传过图**

如果对上了：真正的错误码是 `ATTACHMENT_NOT_FOUND`（附件对象被删），被 `llm-deepseek` 适配器的兜底 `catch` 一律包成了 `TRANSPORT`，于是错误文案把你带向"网络问题"这个死胡同。**和网络、代理、证书、余额都无关**，重试 5 次也纯属白等。

## 二、它做什么

1. 逐帧解压 `session.vN.jsonl.zstd`（拼接帧容器，每帧带 checksum 校验）
2. 读所有 `compaction/*` 事件里的 `shadowedSeqs`，算出**当前视图**——被压缩掉的老消息不能当目标（这是最容易修错的地方）
3. 在视图内的图片引用里，找对象文件不存在的：`<DSH_HOME>/attachments/v1/objects/<sha256前2位>/<sha256>`
4. 往日志末尾追加**一条** `image/offload` 事件（多个目标合并成一条），之后适配器把这些图换成占位文本，不再去读字节
5. 写前自动备份、写后**全量复核**（帧数 +1、行数 +1、末尾事件正确、覆盖后残留为 0）

图片本身不会回来（内容寻址存储，删了无法重建），但**会话能继续说话**。

## 三、快速开始

```bash
# 0) 退出 DeepSeek Harness（必须，见「安全边界」）

# 1) 先看看：哪些会话坏了、要补几处（不写任何东西）
node bin/dsh-fix-attachments.mjs scan

# 2) 修（--session 用会话 id 片段即可；不带就拿全部）
node bin/dsh-fix-attachments.mjs fix --apply --session 642c6f37

# 3) 重新启动 DeepSeek Harness，打开那条会话发一句话验证
```

也支持全局安装后直接敲命令：

```bash
npm i -g dsh-fix-attachments
dsh-fix-attachments scan
```

## 四、命令与选项

| 命令 | 作用 |
| --- | --- |
| `scan` | 只报告（默认命令） |
| `fix [--apply]` | 追加 offload 事件；**不加 `--apply` 就是空跑** |
| `backups --session <片段>` | 列出某条会话的备份 |
| `restore --session <片段> [--stamp <时间戳>] --apply` | 用备份回滚（回滚前会把当前状态另存一份） |

| 选项 | 说明 |
| --- | --- |
| `--session <片段>` | 只处理目录名含该片段的会话 |
| `--dsh-home <路径>` | DSH 主目录（默认 `$DSH_HOME` 或 `~/.dsh`） |
| `--stamp <时间戳>` | restore 时指定用哪个备份（默认最新） |
| `--apply` | 真的写 |
| `--force` | DSH 正在运行也允许写（**确认没人用目标会话**时才用） |
| `--json` | 机读输出 |

退出码：`0` 正常 / `1` 出错 / `2` Node 版本不支持 / `3` 拒绝写入（DSH 在跑或没加 `--apply`）。

## 五、安全边界（重要）

- **默认只读**。不带 `--apply` 永远不写。
- **DSH 正在运行时拒绝写**：它在内存里存着自己的 `next seq`，本工具追加的事件会和它撞号。正确姿势是**退出 → 修 → 重启**。
- **拒绝损坏文件**：日志末尾有撕裂帧、格式版本不认识（非 v4）→ 只报告，不动手。
- **备份**：`session.vN.jsonl.zstd.bak-<时间戳>`，与日志同目录。
- **幂等**：修过的会话再跑一遍是 `没有需要修的会话`，不会重复追加。

## 六、没生效 / 想回滚

- 追加事件后**必须重启 DSH** 才被加载；重启前不要在被修的会话里发消息。
- 回滚：`node bin/dsh-fix-attachments.mjs backups --session <片段>` 找到备份，然后
  `node bin/dsh-fix-attachments.mjs restore --session <片段> --apply`（或直接把 `.bak-*` 覆盖回原名）。

## 七、为什么会有下一次（上游缺陷）

**这是止血，不是治本。** 附件对象会周期性地消失（实测两次：2026-10-26、2026-10-30，第二次一次少了 12 个对象），一旦被当前视图里的消息引用，这条会话立刻变砖。上游已有多个重复报告，截至 0.2.1-rc.5 仍在：

- [#6818](https://github.com/deepseek-ai/deepseek-harness/discussions/6818) · [#7834](https://github.com/deepseek-ai/deepseek-harness/discussions/7834) · [#9262](https://github.com/deepseek-ai/deepseek-harness/discussions/9262) · [#10242](https://github.com/deepseek-ai/deepseek-harness/discussions/10242) · [#10842](https://github.com/deepseek-ai/deepseek-harness/discussions/10842)

真正的修法是在 `prepareImages` 里对每张图 `try/catch`：读不出来的降级成占位文本（而不是抛错），至少把 `ATTACHMENT_NOT_FOUND` 原样透出、不要包成 `TRANSPORT`。上游修好后，本工具就只剩"救旧会话"的价值。

## 八、它不是什么

- **不是通用 zstd/日志手术刀**：只认 DSH 的会话格式（v4）与 `image/offload` 语义，别的日志不要拿它乱试。
- **不改 DSH 安装**：不碰 `app.asar`、不碰插件、不碰 bot 代码，只追加会话日志里的一条事件。
- **不恢复图片内容**：对象是内容寻址的，字节没了就是没了。

## 九、兼容性

- Node **≥ 22.15 或 ≥ 23**（用到 `node:zlib` 的同步 zstd API）。实测 Node 24.18。
- Windows / macOS / Linux 同一套代码（"DSH 是否在运行"那段按平台分支）。
- 会话格式 **v4**；`session` 头事件里 `version` 不是 4 会拒绝写入（避免瞎猜格式）。

## 十、开发

```bash
npm test          # node --test，9 个用例：格式探测 / 阴影排除 / 应用 / 幂等 / 回滚 / 撕裂帧 / CLI 空跑
```

测试用**合成 fixtures**（现场造一个迷你会话 + 附件库），不碰真实用户数据。

## License

MIT，见 [LICENSE](LICENSE)。

> 与 DeepSeek 官方无关，非官方工具，按原样提供、不提供任何担保。**它会改写你的会话日志文件**——请先读第五节的安全边界。
