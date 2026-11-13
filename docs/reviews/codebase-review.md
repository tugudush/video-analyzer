# Codebase review

Reviewed: 2026-11-13

## Summary

The shared operation registry keeps the CLI and MCP interfaces aligned, and the
project has strict TypeScript settings and substantial unit and local integration
coverage. Four reproducible issues were found in the Windows Skill launcher and
the upload cache; all four are fixed, each with a regression test that fails
against the previous implementation. See [Resolution](#resolution).

Severity describes impact in the stated circumstances, not a claim that every
deployment is affected.

## Findings

### P2 - Windows launcher misinterprets metacharacters in its temporary path

**Locations:** [invoke.mjs](../../skills/video-analyzer/scripts/invoke.mjs#L86),
[invoke.mjs](../../skills/video-analyzer/scripts/invoke.mjs#L99),
[invoke.mjs](../../skills/video-analyzer/scripts/invoke.mjs#L200),
[skill.test.ts](../../tests/skill/skill.test.ts#L256).

For the global Windows installation, the launcher stages the JSON in a
temporary file but passes that file's path through `cmd.exe`. Node's argument
quoting does not protect a path containing `&` unless it also needs quoting for
another reason, so `cmd.exe` interprets the character as a command separator.
With a temporary directory named `temp&folder`, a local reproduction passed
only the prefix ending in `temp` to the CLI, which returned `INPUT_NOT_FOUND`;
the shell also attempted to interpret the remainder as a command. The existing
Windows test puts metacharacters in the JSON, not in the temporary path.

**Recommendation:** Avoid shell parsing for the launcher or correctly protect
every argument passed to the batch shim. Add Windows tests with metacharacters
and spaces in the temporary directory and verify both successful forwarding and
the absence of unintended commands.

**Status:** Resolved. The payload is streamed over stdin, so neither the JSON nor
a staging path reaches the `cmd.exe` command line. The shell route now accepts
only operation names and flags (`[A-Za-z0-9_.:-]+`) and refuses anything else
with `INVALID_INPUT` instead of passing it to the shell.

### P2 - Large JSON files fail before the Skill launcher can return an envelope

**Locations:** [invoke.mjs](../../skills/video-analyzer/scripts/invoke.mjs#L99),
[invoke.mjs](../../skills/video-analyzer/scripts/invoke.mjs#L194),
[cli.ts](../../src/adapters/cli.ts#L37).

The launcher reads `--json-file` into memory and, for a checkout-relative build
or explicit CLI override, passes its contents as a command-line argument.
Windows has a much smaller command-line limit than the CLI's 1 MiB input
limit. A local 40,000-character JSON-file probe failed with a synchronous
`spawn ENAMETOOLONG`, printed a Node stack trace, and produced no JSON envelope.
Using `--json-file` therefore does not avoid the limit in this route.

**Recommendation:** Forward the file path or use stdin for the direct Node
route, retaining the CLI's size checks. Normalize synchronous spawn failures as
well as child `error` events. Test a valid payload larger than the Windows
command-line limit through `--json-file`.

**Status:** Resolved. `--json-file` is streamed into the CLI's stdin rather than
materialised as an argument, so the 1 MiB payload cap is the only limit.
Synchronous `spawn` failures are converted into the normal JSON envelope instead
of escaping as a stack trace.

### P2 - A cache flush can hide newer in-memory updates

**Locations:** [uploadCache.ts](../../src/services/uploadCache.ts#L130),
[uploadCache.ts](../../src/services/uploadCache.ts#L224),
[uploadCache.ts](../../src/services/uploadCache.ts#L243),
[uploadCache.ts](../../src/services/uploadCache.ts#L137).

`writePending` takes a batch and awaits the disk merge. If `set` queues another
entry while that await is in progress, the older batch subsequently clears and
replaces the in-memory map without applying the newer queued operation. Until
the next flush finishes, `get` misses that entry and `delete` may refuse to
queue its removal. In an instrumented local interleaving, setting `b` during
the first merge made it disappear from memory; deleting it then did nothing,
and `b` reappeared after the queued write and reload. Concurrent AI calls can
therefore miss reusable uploads, and a concurrent invalidation can be lost.

**Recommendation:** Preserve or replay operations queued during the merge
before publishing the in-memory view, and ensure deletion is represented even
when an entry is temporarily absent. Add a deterministic test that pauses the
merge, performs overlapping set and delete operations, and checks both the
live view and the reloaded file.

**Status:** Resolved. `writePending` replays every operation queued during the
merge onto the published in-memory view, so a concurrent `set` stays visible and
a following `delete` is queued rather than dropped.

### P2 - Transient cache-validation errors trigger unnecessary uploads

**Locations:** [gemini.ts](../../src/services/gemini.ts#L329),
[gemini.ts](../../src/services/gemini.ts#L486),
[gemini.ts](../../src/services/gemini.ts#L508).

`checkActive` treats every non-`VideoAnalyzerError` from `getFile` as a cache
miss. This includes provider quota, authentication, and network errors, not
just a missing or inactive file. The caller discards the reference and starts
another upload, potentially wasting bandwidth and quota and obscuring the
original failure. With a fake provider whose status request returned a 429,
two requests for the same content performed two uploads.

**Recommendation:** Treat only a definitive missing or inactive file as a miss;
surface transient, quota, and authorization failures without deleting the
reference. Cover both memory and persistent-cache paths with simulated 404,
429, and network failures.

**Status:** Resolved. Only a not-found response is read as a cache miss; any
other provider failure is reported as `GEMINI_REQUEST_FAILED` and the reference
is kept, so a retry can still reuse it.

## Resolution

| Finding                             | Change                                                                                                          | Regression test                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Windows launcher metacharacters     | The payload, and its staging path, never reach `cmd.exe`; the shell route accepts only `[A-Za-z0-9_.:-]+` args. | `streams a --json-file payload whose path has shell metacharacters`                                                                   |
| Large JSON payloads                 | `--json-file` is streamed to stdin; synchronous spawn errors become a JSON envelope.                            | `streams a payload larger than a Windows command line`                                                                                |
| Cache flush losing queued updates   | Operations queued during the merge are replayed before the in-memory view is published.                         | `keeps operations queued while an earlier write is in flight`                                                                         |
| Validation errors causing re-upload | A status failure other than not-found surfaces as `GEMINI_REQUEST_FAILED` and keeps the cached reference.       | `reports a provider failure instead of re-uploading the same content`<br>`keeps a persisted reference the provider could not confirm` |

## Validation and limits

- `npm run check` passed on Windows with Node 26.11.1: typecheck, lint, build,
  427 tests, and formatting passed; two tests were skipped.
- Each new regression test was run against the pre-fix code first: the cache
  race, the in-memory provider failure, and the persisted-reference case all
  failed there and pass after the change. The launcher findings were reproduced
  with synthetic local inputs before the fix.
- The cache race uses controlled scheduling around the disk merge; the provider
  findings use a fake Gemini API. No real credentials or external media were
  used.
- The live Gemini test was skipped, so provider compatibility and current
  third-party platform behavior were not verified. CI currently runs on
  Ubuntu with Node 22 ([ci.yml](../../.github/workflows/ci.yml)); a Windows job
  would exercise the platform-specific launcher and filesystem tests.
- This is a risk-focused review, not an exhaustive security audit.
