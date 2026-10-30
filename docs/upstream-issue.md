# 上游 issue 草稿（可直接粘到 GitHub Discussions）

> ✅ **已发布**：2026-10-30 → https://github.com/deepseek-ai/deepseek-harness/discussions/11520 （分类 `General`，与 #7834 / #9262 同类）
>
> 下面是当时发的原文留档；再发一次前先搜一下有没有更新的重复报告。

> **怎么用**：把下面「--- 粘贴区 ---」之间的英文正文整段复制，
> 发到 https://github.com/deepseek-ai/deepseek-harness/discussions（选 Bug / Q&A 均可）。
> 标题用第一行的 `Title:`。已有重复报告可先在这些贴里回帖附证据：
> [#6818](https://github.com/deepseek-ai/deepseek-harness/discussions/6818)、
> [#7834](https://github.com/deepseek-ai/deepseek-harness/discussions/7834)、
> [#9262](https://github.com/deepseek-ai/deepseek-harness/discussions/9262)、
> [#10242](https://github.com/deepseek-ai/deepseek-harness/discussions/10242)、
> [#10842](https://github.com/deepseek-ai/deepseek-harness/discussions/10842)。
>
> 说明：所有数字都是本机实测（2026-10-26 / 2026-10-30，DSH 0.2.1-rc.5，Windows 11，
> 会话格式 v4）。不要把这段中文说明一起粘进去。

---

## 粘贴区

**Title:** Missing attachment object bricks a session permanently: every turn fails with `TRANSPORT` ("DeepSeek Messages transport failed") in ~25 ms, with zero HTTP requests and 5 pointless retries

### Summary

If a content-addressed attachment object referenced by a session's history is deleted, that session can never send a message again. Every turn fails with:

```json
{"type":"turn/end","data":{"reason":{"kind":"error","error":{
  "message":"DeepSeek Messages transport failed","code":"TRANSPORT"}}}}
```

The label is wrong: **no network request is ever made**. The real error is `ATTACHMENT_NOT_FOUND`, thrown while preparing the request, and swallowed by the adapter's catch-all into `TRANSPORT`. Because `TRANSPORT` is in the default retry set, each step then retries five times with backoff and fails anyway.

### Environment

- DSH desktop `0.2.1-rc.5` (also observed on `0.2.0-rc.2` per the linked reports), Windows 11
- Session format v4, ~115k events / ~90 MB artifact
- Provider `deepseek-account` (also reproduced with `deepseek-official` in the same session)

### Decisive evidence: this is a local failure, not transport

```
115582 assistant/attempt   +60ms  finish=error TRANSPORT
115583 llm/retry           +5ms   retry=1 delay=500ms
115584 llm/retry-started   +506ms
115585 assistant/attempt   +25ms  finish=error TRANSPORT
115586 llm/retry           +1ms   retry=2 delay=1053ms
...
115597 assistant/attempt   +29ms  finish=error TRANSPORT
115598 step/end
115599 turn/end            reason={"kind":"error","code":"TRANSPORT"}
```

- Each attempt fails in **22–70 ms**. A round trip to the Messages endpoint cannot complete in that time; the first attempt fails before any socket work.
- Six attempts per turn, backoff 0.5 → 1.05 → 2.1 → 4.1 → 8.6 s, all failing identically.
- From the same machine, at the same time: `node -e "fetch('https://api.deepseek.com/v1/models')"` returns `401` (endpoint reachable, TLS/DNS fine), and **other sessions on both provider routes work normally**.
- Switching provider (`deepseek-account` ↔ `deepseek-official`) changes nothing.

### Root cause

1. `prepareImages` re-reads every image reference in the request history on **every** request (there is no cross-request cache for the raw bytes). In the installed build the loop is:

   ```js
   for (const message of messages)
     for (const ref of imageRefs(message.content))
       if (!versions.has(ref.attachmentId))
         versions.set(ref.attachmentId, await attachments.readImageRequest(ref, target, signal));
   ```

2. The local attachment store throws a precise error when the object is gone:

   ```js
   if (error.code === "ENOENT")
     throw new AttachmentError("Attachment object is missing.", "ATTACHMENT_NOT_FOUND");
   ```

3. The DeepSeek Messages adapter wraps **any** non-`LlmError` thrown during the request generator into `TRANSPORT`:

   ```js
   if (error instanceof LlmError) throw error;
   throw new LlmError("DeepSeek Messages transport failed", "TRANSPORT", { cause: error });
   ```

   The accurate code survives in `LlmError.cause`, but it is not surfaced anywhere the user (or a plugin) can see it.

4. `TRANSPORT` is retryable, so the retry policy spends ~15 s per step retrying a **local file-not-found** condition.

### Minimal reproduction

1. In a session, make the model read an image (screenshot tool, upload, etc.).
2. Delete that object from `<DSH_HOME>/attachments/v1/objects/<sha256[0:2]>/<sha256>`.
3. Send any further message in that session.

Result: `turn/end` with `{"kind":"error","code":"TRANSPORT"}`; 5 `llm/retry` events; no outbound HTTP request; new sessions are unaffected (they do not reference the object).

### Expected

- The failure must identify the attachment (which one, which message), and
- A missing object must not brick the whole session. Degrading that occurrence to placeholder text is enough to keep the session usable — this is already the semantics of `image/offload` (an omitted image renders as placeholder text and the session keeps working).

### Proposed fixes (small → large)

**A. Surface the real code (no behaviour change).** In the adapter's catch-all, translate `AttachmentError` instead of blanket-wrapping it:

```js
if (error instanceof AttachmentError)
  throw new LlmError(
    `DeepSeek Messages could not read attachment ${ref.attachmentId}: ${error.message}`,
    error.code,           // e.g. ATTACHMENT_NOT_FOUND
    { cause: error },
  );
```

`ATTACHMENT_NOT_FOUND` is not in the retry set, so the five pointless retries disappear for free, and the message finally points at the file.

**B. Degrade instead of failing (fixes the bricking).** In `prepareImages`, treat "the store cannot produce bytes" as *unavailable* rather than fatal, and project those occurrences to placeholder text for this request only (the durable log keeps the original reference, exactly like `image/offload`):

```js
const unavailable = new Set();
for (const message of messages)
  for (const ref of imageRefs(message.content)) {
    if (versions.has(ref.attachmentId) || unavailable.has(ref.attachmentId)) continue;
    const version = await readRequestImage(attachments, ref, target, signal); // returns undefined if unreadable
    if (version === undefined) unavailable.add(ref.attachmentId);
    else versions.set(ref.attachmentId, version);
  }
const retained = projectUnavailableImages(messages, unavailable, unavailableImageText);
```

Only "the stored bytes cannot be produced" (`ATTACHMENT_NOT_FOUND` / `ATTACHMENT_READ_FAILED` / `ATTACHMENT_CORRUPT`) should degrade; every other attachment error should still fail with its own code.

**C. Optional.** Expose the attachment failure reason in `turn/end` so the desktop UI can say "an image in this session is gone" instead of "transport failed".

### Why this matters

Attachments are content-addressed: the object name *is* the hash of its bytes. Once deleted there is no way to reconstruct the object from the session log or from the reference, so the session is **permanently** unable to send messages — the user's only options are "start a new session" or hand-edit the zstd artifact.

### Related reports

Same defect, still reproducible on `0.2.1-rc.5`: #6818, #7834, #9262, #10242, #10842.

### Workaround

Until this is fixed, sessions can be rescued by appending a durable `image/offload` event covering the unreadable occurrences (the mechanism the compaction image-offload path already uses). I published a small MIT-licensed plugin + offline CLI that does this and verifies the result: https://github.com/xuzhunzhi/dsh-fix-attachments

One more datapoint that may help triage: the accurate code is invisible to plugin authors too. `agent/request-error` hands listeners a `LlmFailure` with only `message / code / status / providerRetryAfterMs / requestId / offloadImages` — the `ATTACHMENT_NOT_FOUND` inside `cause` never reaches us, so the only way to tell "attachment is gone" from "network died" is to probe the attachment store ourselves on every failure.

---

## 给作者自己的备注（不粘贴）

- 附上修复前后对比会更有说服力：修之前 `turn 1455/1456/1457` 全 `TRANSPORT`；追加 offload 后同一会话恢复正常。
- 如果上游问"为什么对象会消失"：我这边实测两次（10-26、10-30），能确认的是 `objects` 目录 mtime 对得上、且是**批量**消失（第二次 12 个），但**没定位到是谁删的**（DSH 升级到 rc.5 的时间接近，可疑但未证实）。这一点要如实写"未定位"。
