# dsh-fix-attachments

> A DeepSeek Harness plugin for the session that fails **every** turn with `DeepSeek Messages transport failed`: it degrades unreadable images to placeholder text and lets the turn continue.

Category: **Development & Operations** · MIT · [中文说明](README.md)

## What it is worth

Before: a session becomes permanently unable to send messages — start over or hand-edit a zstd artifact.
After: the turn repairs itself in place and retries, so the user only notices a short pause.

## Symptom

- One session fails on **every** turn: `DeepSeek Messages transport failed` (`code: TRANSPORT`)
- Each attempt dies in **20–60 ms** with **no HTTP request sent** — the decisive signal
- 5 retries with backoff, all failing
- Other sessions on the same machine/model/provider are fine
- The history contains images

Root cause: attachment objects are content-addressed under `<DSH_HOME>/attachments/v1/objects/<xx>/<sha256>`. Once an object is deleted, `prepareImages` re-reads it on every request, throws `ATTACHMENT_NOT_FOUND`, and the DeepSeek Messages adapter wraps any non-LLM error into `TRANSPORT`. Nothing to do with the network; the retries are wasted.

## Two forms, one judgement

| Form | When | How |
| --- | --- | --- |
| **Plugin** (recommended) | everyday: repairs in-process, no restart, no manual step | install into a profile |
| **Offline CLI** | when the app cannot start, or to audit all sessions | `node cli/bin/dsh-fix-attachments.mjs scan` |

## Install

```bash
dsh plugin --profile desktop add dsh-fix-attachments          # once published to npm
dsh plugin --profile desktop add github:xuzhunzhi/dsh-fix-attachments   # from source
```

Optional config through the profile's `cordis.patch.yml`:

```yaml
- id: dsh-fix-attachments
  config:
    objectsRoot: '/path/to/attachments/v1/objects'
    maxRepairsPerTurn: 3
```

(An entry with `id` and no `insert` is a targeted override — it replaces that entry's `config` wholesale. Install only through `dsh plugin ... add`; do not hand-write the profile's `package.json` or insertion rows.)

## Verify it is running

On mount the plugin writes a small state file (and updates it on every repair) — the first place to look when "it does not seem to do anything":

```bash
cat ~/.dsh/storages/dsh-fix-attachments-state.json
```

`mountedAt` present ⇒ the plugin was loaded. `repairs` / `lastRepair` show what it actually fixed.

## How the plugin works

It hooks the agent loop's `agent/request-error` waterfall — the same extension point the official context-overflow recovery and image-budget offload use:

1. On a request error, check whether the code is `TRANSPORT` / `ATTACHMENT_NOT_FOUND`.
2. Walk the **current surface** (`session.surface.nodes`, so messages a compaction dropped are excluded) and test each image reference for its object file; skip blocks already marked `offloaded`.
3. If any are unreadable, append one `image/offload` event with all of them (`session.append`), the mechanism the official `compaction-image-offload` plugin already uses, then cross the durability barrier with `await ctx.sessions.flush(session)` (an append only lands in the in-memory session; callers that need durability await the flush).
4. Return `{ kind: 'retry' }` so the request retries immediately — a durable repair, not a provider retry: it spends no retry budget and logs no `llm/retry`.
5. Nothing unreadable → `next()`, leaving genuine network errors untouched.

Two deliberate choices: it never inspects the `cause` chain (a real network failure is never masked), and repairs are bounded per turn (they also self-terminate, since repaired images become `offloaded`).

## Offline CLI

```bash
node cli/bin/dsh-fix-attachments.mjs scan                            # report only
node cli/bin/dsh-fix-attachments.mjs fix --apply                     # write (quit DSH first)
node cli/bin/dsh-fix-attachments.mjs backups --session <id>
node cli/bin/dsh-fix-attachments.mjs restore --session <id> --apply
```

It decodes the frame container, reconstructs the compaction shadow set itself, appends one checksummed frame, and verifies by re-reading everything. It refuses to write while DSH is running (sequence collision), on a torn final frame, or on an unknown session format version.

## Limits

- Deleted image bytes never come back; the session just keeps working.
- The root cause remains (objects keep disappearing — observed twice), so keep it installed.
- Does not patch the DSH installation; it only appends one durable event.
- Community project, not affiliated with DeepSeek AI.

## Upstream defect

See [#6818](https://github.com/deepseek-ai/deepseek-harness/discussions/6818), [#7834](https://github.com/deepseek-ai/deepseek-harness/discussions/7834), [#9262](https://github.com/deepseek-ai/deepseek-harness/discussions/9262), [#10242](https://github.com/deepseek-ai/deepseek-harness/discussions/10242), [#10842](https://github.com/deepseek-ai/deepseek-harness/discussions/10842). A paste-ready report is in [`docs/upstream-issue.md`](docs/upstream-issue.md).

## Compatibility

DSH `0.2.1-rc.5` verified · Node ≥ 22.15 (CLI) · Windows/macOS/Linux · session format v4.

## Development

```bash
npm test    # node --test, 15 cases
```

## License

MIT — see [LICENSE](LICENSE). Provided as-is, without warranty.
