# dsh-fix-attachments

> Rescue a DeepSeek Harness session that fails **every** turn with `DeepSeek Messages transport failed` because an attachment object referenced by its history was deleted.

中文说明见 [README.md](README.md)（primary documentation is Chinese; this file is the English mirror).

---

## Symptom checklist

You are in the right place if all of these hold:

- One specific session fails on **every** turn with `DeepSeek Messages transport failed` (`code: TRANSPORT`).
- Each attempt dies in **20–60 ms** and **no HTTP request is ever sent** — this is the decisive signal.
- The turn retries 5 times with backoff, then fails.
- Other sessions on the same machine, same provider, same model work fine.
- Network / proxy / API key / provider changes make no difference.
- That session's history contains images (read, screenshots, uploads).

The real error is `ATTACHMENT_NOT_FOUND` — a content-addressed attachment object is gone — and the DeepSeek Messages adapter wraps every non-LLM error thrown during request preparation into `TRANSPORT`. The label is misleading: this is a purely local failure.

## What it does

1. Decompresses every frame of `session.vN.jsonl.zstd` (concatenated, checksummed zstd frames).
2. Reconstructs the **current surface** from each `compaction/*` event's `shadowedSeqs`, so messages a compaction dropped are never targeted.
3. Finds image references on that surface whose object is missing under `<DSH_HOME>/attachments/v1/objects/<xx>/<sha256>`.
4. Appends **one** `image/offload` event (all targets merged) so the adapter sends placeholder text instead of reading those bytes.
5. Backs up before writing and fully re-reads/verifies after writing (frame count, line count, last event, zero residual work).

The images themselves cannot be recovered (content-addressed storage), but the session talks again.

## Quick start

```bash
# 0) quit DeepSeek Harness first (see Safety)
node bin/dsh-fix-attachments.mjs scan                       # report only
node bin/dsh-fix-attachments.mjs fix --apply --session 642c6f37
# 3) start DeepSeek Harness again and send one message
```

CLI messages are currently Chinese; the JSON output (`--json`) is language-neutral.

## Commands

| Command | Effect |
| --- | --- |
| `scan` | report only (default) |
| `fix [--apply]` | append the offload event; dry run without `--apply` |
| `backups --session <id>` | list backups |
| `restore --session <id> [--stamp <t>] --apply` | roll back from a backup |

Options: `--session <substring>`, `--dsh-home <path>`, `--stamp <stamp>`, `--apply`, `--force`, `--json`.
Exit codes: `0` ok, `1` error, `2` unsupported Node, `3` refused.

## Safety

- Read-only unless `--apply`.
- **Refuses to write while DeepSeek Harness is running** (its in-memory next-sequence counter would collide with the appended event); quit it first, or pass `--force` only if you are certain nothing is using that session.
- Refuses artifacts with a torn final frame or an unknown session format version.
- Writes a `session.vN.jsonl.zstd.bak-<stamp>` backup next to the artifact.
- Idempotent: a repaired session scans as `nothing to fix`.

## Upstream bug

This is a workaround. Objects disappear periodically and upstream still reports the same defect on 0.2.1-rc.5: [#6818](https://github.com/deepseek-ai/deepseek-harness/discussions/6818), [#7834](https://github.com/deepseek-ai/deepseek-harness/discussions/7834), [#9262](https://github.com/deepseek-ai/deepseek-harness/discussions/9262), [#10242](https://github.com/deepseek-ai/deepseek-harness/discussions/10242), [#10842](https://github.com/deepseek-ai/deepseek-harness/discussions/10842). The proper fix degrades unreadable images to placeholder text in `prepareImages` and surfaces `ATTACHMENT_NOT_FOUND` instead of `TRANSPORT`.

## Not this tool

- Not a general zstd/log surgery utility — it only understands DSH session format v4 and `image/offload` semantics.
- Does not patch the DSH installation, its plugins, or any bot code. It only appends one event to a session artifact.
- Does not restore deleted image bytes.

## Compatibility

Node ≥ 22.15 or ≥ 23 (synchronous `node:zlib` zstd API). Tested on 24.18. Windows/macOS/Linux. Session format v4 only; anything else is refused rather than guessed.

## Development

```bash
npm test    # 9 cases: format probe, shadow exclusion, apply, idempotency, restore, torn frame, CLI dry run
```

## License

MIT — see [LICENSE](LICENSE). Not affiliated with DeepSeek; provided as-is without warranty. **It rewrites session log files** — read the safety section first.
