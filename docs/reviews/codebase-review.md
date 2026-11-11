# Codebase Review

**Date:** 2026-11-11
**Revision:** `1795c4e` (`main`, working tree apart from this file)
**Scope:** all of [`src/`](../../src), [`tests/`](../../tests), [`skills/`](../../skills), the user-facing docs, and the build/lint/test configuration.

## Method

- Read every source file: the six operations, both adapters, the Gemini and FFmpeg services, the media-input and network helpers, and all utilities (≈3.7k lines across 29 files).
- Read all 21 test files (≈2.6k lines), the README, `SKILL.md`, the three Skill reference documents, and `findings-and-plan.md`.
- Ran the full gate: `npm run check` (typecheck → oxlint → vitest → prettier). **Result: green** — `tsc --noEmit` clean, oxlint clean, **194 passed / 1 skipped** across 19 files in ~6.3 s, Prettier clean. `npm run build` also succeeds.
- Re-ran the suite with `FFMPEG_PATH`/`FFPROBE_PATH` pointing at a missing binary to measure the real skip count.
- Probed runtime behaviour against the built `dist/` with scripted repros: `.env` parsing, a cancelled FFmpeg run, download timeout and mid-stream cancellation, the CLI's `--input-file` path, `transcribe_video`'s pre-flight side effects, and the Skill launcher's Windows `.cmd` shim.

This is a well-structured, unusually disciplined codebase. Layering is clean (registry → operations → services → utils, with thin adapters), the error model is uniform and typed, security-sensitive paths are hardened deliberately, and the test suite is fast and behaviour-oriented. The findings below are contract, robustness, and documentation issues; **no P1 defect and no exploitable security hole was found**.

All 15 findings from the previous review (recorded at `12d2c45`) were re-checked and remain resolved; nothing in this document re-litigates them.

## Findings Summary

| #   | Severity | Area             | Finding                                                                                                                                                             |
| --- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2       | Configuration    | A quoted `.env` value with a trailing comment is stored verbatim (`"key" # note`), producing a silently invalid `GEMINI_API_KEY`                                    |
| 2   | P2       | Skill robustness | On the Windows global-`.cmd`-shim install path, the launcher routes the JSON payload through `cmd.exe`, so `&`, `\|`, or `^` corrupts the arguments                 |
| 3   | P3       | Error contract   | Cancelling a local FFmpeg run reports `MEDIA_PROCESSING_FAILED: ffmpeg failed.` with a raw encoder-log tail instead of a cancellation                               |
| 4   | P3       | Error contract   | Download timeout reports "Check network access and that the URL is publicly reachable"; a caller abort mid-stream reports "Failed to write `<path>`"                |
| 5   | P3       | Error contract   | `--input-file` pointing at a missing file reports `INTERNAL` (an ENOENT message), while the Skill launcher reports `INPUT_NOT_FOUND` for the same mistake           |
| 6   | P3       | Side effects     | `transcribe_video` creates missing `outputPath` parent directories during validation, so a `CONFIG_MISSING` call still leaves empty directories behind              |
| 7   | P3       | Docs accuracy    | README claims a run without FFmpeg skips 15 tests; the measured number is 11                                                                                        |
| 8   | P3       | MCP contract     | `get_video_info` publishes `readOnlyHint: false` although it writes nothing, so clients prompt for a tool that cannot damage anything                               |
| 9   | P3       | Docs accuracy    | [`findings-and-plan.md`](../../findings-and-plan.md) still says "Planning only — do not implement yet" and documents yt-dlp and AI frame sampling that were removed |
| 10  | P4       | Repo hygiene     | `.gitignore` carries a `.video-analyzer/` entry that nothing in the repo creates                                                                                    |

## Findings

### P2: A quoted `.env` value with a trailing comment is stored verbatim

**Where:** [`parseDotEnv`](../../src/utils/dotenv.ts:37) — the quoted branch at [line 49](../../src/utils/dotenv.ts:49) and [`stripQuotes`](../../src/utils/dotenv.ts:22).

Values beginning with a quote go through `stripQuotes`, which only removes the quotes when the **last** character is also a quote. An inline comment therefore defeats both the quote handling and the comment handling, because the comment branch is the `else` arm.

```text
input:  A="quoted value" # trailing note
result: A = '"quoted value" # trailing note'
```

Reproduced against the built parser:

```text
{
  "A": "\"quoted value\" # trailing note",
  "B": "plain",
  "C": "'single' # note",
  "D": "has # hash"
}
```

**Impact:** `.env` files routinely annotate secrets (`GEMINI_API_KEY="AIza…" # aistudio`). Such a key is loaded with the quotes and the comment embedded and with no diagnostic, and the user is then told "Check your API key, quota, and network access" (`GEMINI_REQUEST_FAILED`) while holding a correct key. Both quoting styles and trailing comments are documented as supported in [`configuration.md`](../../skills/video-analyzer/references/configuration.md) and in the [`dotenv.ts`](../../src/utils/dotenv.ts:8) header comment, so this is a documented contract that does not hold.

**Suggested fix:** strip a trailing `\s+#…` comment before quote stripping when the value is quoted (or match `^(['"])(.*)\1(?:\s+#.*)?$` first and fall back to the current logic). Add the quoted-plus-comment case to [`tests/unit/dotenv.test.ts`](../../tests/unit/dotenv.test.ts), which currently covers quotes and comments only in isolation.

### P2: The Windows `.cmd` shim corrupts payloads containing shell metacharacters

**Where:** [`invoke.mjs:118`](../../skills/video-analyzer/scripts/invoke.mjs:118).

For a user-level Skill install resolved to the npm bin shim, the launcher runs `cmd.exe /d /s /c video-analyzer.cmd <operation> --input <json>`. `cmd.exe` re-parses that command line, so `&`, `|`, and `^` inside the JSON become shell operators before the CLI ever sees them.

Reproduced with the launcher copied to a directory that forces the `video-analyzer.cmd` path (no local `dist/`, no `VIDEO_ANALYZER_CLI_PATH`):

```text
$ node invoke.mjs analyze_video '{"videoPath":"C:\\media\\a&b.mp4","question":"What does \"Q3\" mean & why?"}'
{"ok":false,"error":{"code":"INVALID_INPUT","message":"Arguments must be valid JSON.", …}}
exit=1

$ node invoke.mjs analyze_video '{"videoPath":"C:\\media\\a^b|c.mp4","question":"why?"}'
The filename, directory name, or volume label syntax is incorrect.
exit=255          # no JSON envelope at all: the launcher's own contract is broken
```

The `VIDEO_ANALYZER_CLI_PATH` path and the repo-relative build path spawn `process.execPath` directly and are unaffected, which is why this only shows up for the documented global install.

**Impact:** Windows paths containing `&` (for example a folder called `Q&A`) and questions containing `&` or `|` fail with a misleading "Arguments must be valid JSON", or with no envelope at all. [`SKILL.md`](../../skills/video-analyzer/SKILL.md) recommends `--json-file` on Windows shells, which avoids it, but the launcher still accepts the inline form the examples show, and the documented `--pretty`/forwarded arguments take the same route.

**Suggested fix:** do not let `cmd.exe` re-parse the payload. Resolve the shim to its underlying script (read the `.cmd` and spawn its `node …` target), or pass arguments through a single quoted command string with `^`-escaping of `& | ^ < > ( ) "`, or write the payload to a temporary file and forward `--input-file`. Cover it with a launcher test that runs a payload containing `&`, `|`, and a space.

### P3: Cancelling a local FFmpeg run is reported as a media-processing failure

**Where:** [`run()` in ffmpeg.ts:57](../../src/services/ffmpeg.ts:57); the generic branch at [line 79](../../src/services/ffmpeg.ts:79).

`execFile` with a `signal` rejects with an `AbortError` when the caller cancels, but only `ENOENT` is special-cased, so every other rejection — cancellation included — becomes `MEDIA_PROCESSING_FAILED: ffmpeg failed.` with the last four stderr lines as the hint.

Reproduced by aborting an `extract_frames` interval run 150 ms in:

```json
{
  "code": "MEDIA_PROCESSING_FAILED",
  "message": "ffmpeg failed.",
  "hint": "handler_name    : VideoHandler\r\n    Side data:\r\n … [Parsed_showinfo_2] n: 1 pts: 1 pts_time:0.1 …"
}
```

**Impact:** the Gemini side maps cancellation to an explicit "The Gemini request was cancelled" ([`gemini.ts:217`](../../src/services/gemini.ts:217)), but the local side tells the user — and the agent relaying it — that the media failed to process, with a raw `showinfo` dump as the hint. [`troubleshooting.md`](../../skills/video-analyzer/references/troubleshooting.md) maps `MEDIA_PROCESSING_FAILED` to "corrupt file, re-encode", so a Ctrl-C sends the user down the wrong path and can prompt a needless re-encode.

**Suggested fix:** check `signal?.aborted` (or `error.name === 'AbortError'` via the existing [`isAbortError`](../../src/utils/abort.ts:81) helper) before the generic branch and raise the same cancellation error the Gemini path uses. Add a unit test that aborts an FFmpeg call.

### P3: Download timeout and download cancellation are reported with the wrong cause

**Where:** [`downloadToFile`](../../src/utils/net.ts:224) — the deadline at [line 237](../../src/utils/net.ts:237), the fetch catch at [line 252](../../src/utils/net.ts:252), and the pipeline catch at [line 334](../../src/utils/net.ts:334).

Two distinct failures share one catch-all:

```text
# A server that accepts the connection and never responds (300 ms deadline)
{"code":"DOWNLOAD_FAILED","message":"Failed to download http://…/a.mp4",
 "hint":"Check network access and that the URL is publicly reachable.","cause":"TimeoutError"}

# Caller aborts while the body is streaming
{"code":"DOWNLOAD_FAILED","message":"Failed to write C:\\Temp\\va-net-…\\b.bin","cause":"AbortError"}
```

**Impact:** the timeout hint names the wrong remedy (there is no setting hint even though the budget is `max(VIDEO_ANALYZER_REQUEST_TIMEOUT_MS, 60 s)`), and a cancellation claims a write failure — a message that suggests disk problems for a user who simply pressed Ctrl-C. The whole download budget also hides behind the Gemini request timeout: the default 5 minutes is tight for the default 2 GB limit on a slow link, and nothing in the error says so.

**Suggested fix:** branch on `isAbortError(error)`, and distinguish `signal?.aborted` (cancel) from an internal timeout, with hints naming `VIDEO_ANALYZER_DOWNLOAD_MAX_MB` and the timeout that applied. Consider a dedicated `VIDEO_ANALYZER_DOWNLOAD_TIMEOUT_MS` instead of deriving it from the Gemini request timeout. [`tests/unit/net.test.ts`](../../tests/unit/net.test.ts) currently exercises only `isPrivateAddress` and `assertSafeHttpUrl`, so none of this is pinned.

### P3: A missing `--input-file` reports `INTERNAL`

**Where:** [`cli.ts:181`](../../src/adapters/cli.ts:181).

```text
$ node dist/cli.js get_video_info --input-file ./does-not-exist.json
{"ok":false,"error":{"code":"INTERNAL","message":"ENOENT: no such file or directory, open 'C:\\…\\does-not-exist.json'"}}
```

**Impact:** `INTERNAL` is documented as "a bug in the tool", but this is a caller mistake with an obvious recovery. The Skill launcher already maps the same situation to `INPUT_NOT_FOUND` ([`invoke.mjs:96`](../../skills/video-analyzer/scripts/invoke.mjs:96)), so the two interfaces disagree on the code for an identical error — exactly what the shared error contract exists to prevent.

**Suggested fix:** wrap the `readFile` in a targeted `VideoAnalyzerError('INPUT_NOT_FOUND', …)` with a hint pointing at `--input`/stdin. [`tests/unit/cli.test.ts`](../../tests/unit/cli.test.ts) parses the flag but never exercises the read.

### P3: `transcribe_video` creates output directories before it can fail

**Where:** [`resolveTranscriptTarget`](../../src/operations/transcribeVideo.ts:111) calls [`ensureDir` at line 135](../../src/operations/transcribeVideo.ts:135); the call site runs before the provider check at [line 177](../../src/operations/transcribeVideo.ts:177).

```text
transcribe_video(outputPath: <tmp>/nested/deeper/transcript.txt) without a key
→ CONFIG_MISSING
→ parent dir created despite failure: true
```

**Impact:** low, but the tool leaves filesystem changes behind for a request that produced nothing, and the same happens for an upload failure or a `NO_SPEECH` result. Validating the target early (extension, alias, existing file) is right; creating directories is not part of validation.

**Suggested fix:** move `ensureDir(path.dirname(target))` into `writeTranscript`, immediately before the write, where the `wx`/overwrite logic already lives.

### P3: README overstates how many tests skip without FFmpeg

**Where:** [`README.md:310`](../../README.md).

"a green run without ffmpeg means 15 tests did not execute" — measured with `FFMPEG_PATH`/`FFPROBE_PATH` set to missing binaries:

```text
with ffmpeg:     194 passed |  1 skipped (195)
without ffmpeg:  183 passed | 12 skipped (195)
```

The delta is **11** (the 10 tests in `describe.skipIf(!available)` in [`localMedia.test.ts`](../../tests/integration/localMedia.test.ts:15) plus the FFmpeg-gated MCP test at [`mcpServer.test.ts:97`](../../tests/integration/mcpServer.test.ts:97)). The 12th skip is the always-skipped symlink case on Windows.

**Suggested fix:** say 11, or drop the number and describe the mechanism. Better still, surface the skip count in CI (see Recommendations) so the claim cannot drift again.

### P3: `get_video_info` is published as not read-only

**Where:** [`mcpTools.ts:66`](../../src/adapters/mcpTools.ts:66) → `readOnly: operation.readOnly ?? operation.category === 'analysis'`; published at [`mcpServer.ts:65`](../../src/adapters/mcpServer.ts:65).

`get_video_info` never writes anything a caller keeps: local input is only probed with `ffprobe`, and a remote input is downloaded into a temp directory that `prepareMedia`'s `finally` removes. It is nonetheless classified as not read-only because it lives in the `local` category, while the four Gemini operations — which upload the media to Google — are classified as read-only.

**Impact:** clients that auto-approve or auto-run read-only tools will prompt for the one operation that is provably side-effect free, and the annotation no longer means "writes nothing locally", which is what the four `true` values imply.

**Suggested fix:** give `get_video_info` `readOnly: true` explicitly (it is the only operation that needs an exception), and update the parity assertion in [`parity.test.ts`](../../tests/contract/parity.test.ts:63) accordingly. `openWorldHint: true` for every tool is defensible, since every operation accepts a remote URL.

### P3: The original design document is stale and presented as current rationale

**Where:** [`findings-and-plan.md`](../../findings-and-plan.md) — status line at [line 3](../../findings-and-plan.md:3), yt-dlp design points at [lines 42](../../findings-and-plan.md:42), [84](../../findings-and-plan.md:84) and [109](../../findings-and-plan.md:109), `YT_DLP_*` settings at [line 228](../../findings-and-plan.md:228), frame sampling at [line 86](../../findings-and-plan.md:86).

The document opens with "**Status:** Planning only — do not implement yet" on a shipped codebase, and it directs the reader to capabilities the code deliberately removed: yt-dlp platform downloads, the `YT_DLP_*` settings, and AI frame sampling. The README links it as "the original design rationale", so a new contributor reading the two documents in sequence gets contradictory instructions.

**Suggested fix:** add a short "Superseded" header listing the decisions that changed (platform downloads disabled, `YT_DLP_*` unread, no AI-side frame sampling, `transcribe_video` writes a file) with a pointer to the README, or move the file under `docs/`.

### P4: Dead `.gitignore` entry

**Where:** [`.gitignore:4`](../../.gitignore).

`.video-analyzer/` is ignored but nothing in `src/`, `tests/`, `skills/`, or the docs ever creates or mentions it. It is a leftover from an earlier layout; `video-analyzer-output/` on the next line is the real artifact root.

## Architecture And Quality

**Strengths**

- **One source of truth per concern.** [`registry.ts`](../../src/operations/registry.ts) owns names, titles, schemas, categories, and handlers; both adapters iterate it, and [`parity.test.ts`](../../tests/contract/parity.test.ts) enforces name, schema-identity, description, read-only, and destructive parity. The `satisfies readonly Operation<z.ZodTypeAny>[]` constraint keeps the inferred `OperationName` union honest.
- **Uniform, typed error contract.** Every expected failure is a [`VideoAnalyzerError`](../../src/utils/errors.ts:46) with a stable code from a closed union, an optional hint, and structured `details`; adapters render it as JSON (CLI) or text content (MCP) without leaking stacks or secrets. The mapping defects above (findings 3–5) are visible precisely because the contract is otherwise so consistent.
- **Deterministic services.** [`GeminiMediaService`](../../src/services/gemini.ts:230) takes injectable `api`, `now`, and `sleep`; [`runWithBounds`](../../src/utils/abort.ts:41) makes cancellation and deadlines testable without real timers; FFmpeg runs through `execFile` with argument arrays, so there is no shell and no injection surface.
- **Explicit storage invariants.** "One artifact directory per request" is documented at the type ([`FrameExtractionOptions.outDir`](../../src/services/ffmpeg.ts:163)), enforced for the modes that list the directory, and covered by unit and integration tests.
- **Budgets enforced during production, not after.** `-frames:v` caps interval extraction inside FFmpeg, `resolveFrameBudget` refuses to return `0` (which FFmpeg would read as unlimited), and `extractFramesAtTimestamps` stats every output instead of trusting the exit code.
- **Strictness that pays off.** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, and `isolatedModules` are all enabled and the code satisfies them rather than casting around them.
- **Docs as part of the product.** README, `SKILL.md`, and the three reference documents agree with the code on settings, error codes, exit behaviour, and Windows quirks, and a test enforces that every operation is mentioned in `SKILL.md`. Findings 7 and 9 are the exceptions.

**Weaknesses**

- **Process-global mutable state.** [`sharedService`](../../src/operations/shared.ts:15) and the logger [`sink`](../../src/utils/logger.ts:30) are module-level singletons with test-only reset hooks. Correct for the two shipped entry points; two embedders with different configs or sinks in one process would interfere, and nothing in the public export surface warns about it.
- **Hard-coded FFmpeg budgets.** [`FFMPEG_TIMEOUT_MS`](../../src/services/ffmpeg.ts:10) (10 min) and [`FFPROBE_TIMEOUT_MS`](../../src/services/ffmpeg.ts:11) (60 s) are constants while every Gemini deadline is configurable. Scene detection over a feature-length file can hit the former and surface as a generic `MEDIA_PROCESSING_FAILED`; combined with finding 3, a timeout is indistinguishable from a corrupt file.
- **Validation runs twice per call.** Each adapter validates the payload and then [`executeOperation`](../../src/operations/execute.ts:47) validates again at [line 64](../../src/operations/execute.ts:64). Harmless (parsing is idempotent) and justified as an embedder guarantee, but the operation runs the schema twice on every MCP and CLI call.
- **No retry policy, by design and undocumented.** A transient 5xx or DNS blip fails the operation; MCP clients that auto-retry will re-upload the media, and the upload cache only helps within one process.
- **`ensureDir` uses a dynamic import** ([`fsUtils.ts:60`](../../src/utils/fsUtils.ts:60)) while every other Node builtin is imported statically — a leftover inconsistency on a hot path.
- **No CI.** There is no `.github/workflows`, so `npm run check` only runs when someone remembers to run it, even though the repository's branch/PR history implies a review-first workflow.

## Security Assessment

The network boundary remains the strongest part of the codebase.

- **SSRF defence is layered.** [`assertSafeHttpUrl`](../../src/utils/net.ts:160) rejects non-HTTP(S) schemes, embedded credentials, blocked hostnames (localhost, cloud metadata), and any host that resolves to a private, loopback, link-local, CGNAT, documentation, or multicast range. IPv6 handling covers `::1`, `::`, ULA, link-local, multicast, and IPv4-mapped/NAT64 forms, and fails closed on unparseable input. Downloads revalidate **every redirect hop** with `redirect: 'manual'` rather than letting `fetch` follow blindly.
- **Residual risk is documented honestly.** The resolve→connect window is not pinned, so DNS rebinding remains theoretically possible; the README says so instead of over-claiming. `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true` disables the whole layer for direct downloads, which is also documented.
- **Size bounds are enforced twice.** `Content-Length` is checked before the body is read and the byte count is checked while streaming, so a chunked response cannot exceed `maxBytes`.
- **Command execution is safe.** FFmpeg/FFprobe run via `execFile` with argument arrays; input paths are resolved to absolute paths first, so a `videoPath` beginning with `-` cannot be read as an option.
- **Source-media protection is thorough** for `transcribe_video`: canonical-path comparison (covering `..`, symlinks, casing) plus device/inode comparison (covering hard links) before upload, backed by an exclusive-create `wx` write so a target that appears after validation still cannot be clobbered.
- **Secrets are never logged.** Diagnostics go to stderr or the MCP logging channel; the key is only ever handed to the SDK. `readString` trims values, which also protects against the copy-paste trailing space the README warns about.

**Worth stating more plainly in the README:** AI operations upload user media to Google (currently only under "Known Limitations"); `transcribe_video` and `extract_frames` write to caller-chosen paths, so an agent driving them is as trustworthy as its path choice; and on Windows the Skill payload travels as a command-line argument, which other local processes can observe through the process list.

## Test Assessment

194 passing, 1 skipped, ~6.3 s — fast enough to run on every save, which is why the findings above are small and specific.

| Area                         | Coverage | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini timeouts/cancellation | Strong   | Stalled generation, stalled status poll, stalled upload, pre-aborted signal, upload time counted against the processing deadline, signal + deadline handed to the SDK, MCP cancellation propagation, shared upload surviving its initiator's cancellation.                                                                                                                                                                               |
| Frame budgets                | Strong   | Budget passed as `-frames:v`, on-disk count capped, uncapped config still bounded, paging does not change the produced count, sub-minimum interval rejected before any process runs, `resolveFrameBudget` edge cases.                                                                                                                                                                                                                    |
| Output isolation             | Strong   | Reused directories report only their own frames; pre-populated directories rejected without invoking FFmpeg; integration test reuses one parent directory.                                                                                                                                                                                                                                                                               |
| Source overwrite protection  | Strong   | Relative spelling, `file://`, symlink, hard link, symlinked parent, existing file, directory target, exclusive-create race.                                                                                                                                                                                                                                                                                                              |
| SSRF / download policy       | Good     | Private and reserved ranges, IPv6 forms, credentials, platform-page rejection, opt-in behaviour, declared and streamed size limits, redirect revalidation.                                                                                                                                                                                                                                                                               |
| CLI / MCP parity             | Good     | Names, schema object identity, descriptions, read-only classification, forbidden capability names, tool listing over a real in-memory MCP client.                                                                                                                                                                                                                                                                                        |
| **Gaps**                     | —        | (a) no test for a quoted `.env` value with a trailing comment (finding 1); (b) no test for cancelling a local FFmpeg call (finding 3); (c) `downloadToFile`'s timeout and cancellation mapping is untested (finding 4); (d) no test for a missing `--input-file` (finding 5); (e) no launcher test with `&`/`\|` in the payload (finding 2); (f) the Windows link/case tests self-skip, so a Windows run covers less than it appears to. |

The integration and Skill suites skip themselves when FFmpeg is missing. The README warns about this, but the number it quotes is wrong (finding 7) and nothing makes the skips visible in a CI log, so a "green" run without FFmpeg looks identical to a fully exercised one.

## Verification Performed

```text
npm run check
  typecheck  tsc -p tsconfig.json --noEmit        clean
  lint       oxlint src tests skills              clean
  test       vitest run                           19 files, 194 passed, 1 skipped
  format     prettier --check .                   clean

npm run build                                     clean (dist/cli.js, dist/mcp.js)

FFMPEG_PATH=missing FFPROBE_PATH=missing vitest run
                                                  183 passed, 12 skipped (18 files passed, 1 skipped)
```

Manual probes against the built `dist/` (scripted, temp directories only, no repository writes):

- `.env` parsing of `A="quoted value" # trailing note` → value keeps quotes and comment (finding 1).
- Skill launcher via a stand-in `video-analyzer.cmd` shim: `&` payload → `INVALID_INPUT: Arguments must be valid JSON`; `|` payload → exit 255 with no envelope (finding 2).
- `extract_frames` interval run aborted after 150 ms → `MEDIA_PROCESSING_FAILED: ffmpeg failed.` with a `showinfo` tail (finding 3).
- `downloadToFile` against a hanging local server (300 ms deadline) → `DOWNLOAD_FAILED` + network hint; against a stalling server with a caller abort → `DOWNLOAD_FAILED: Failed to write …` (finding 4).
- `node dist/cli.js get_video_info --input-file ./does-not-exist.json` → `INTERNAL` (finding 5).
- `transcribe_video` with a nested `outputPath` and no key → `CONFIG_MISSING`, and the parent directories exist afterwards (finding 6).
- Full suite with FFmpeg hidden → 11 additional skips (finding 7).

## Recommendations

1. **Fix the two P2s first.** Both are silent-configuration defects that surface as unrelated failures ("bad API key", "invalid JSON"), and each is a few lines plus a test.
2. **Make cancellation a first-class outcome everywhere.** One mapping (`signal.aborted` → cancellation error) applied to FFmpeg, downloads, and Gemini would remove findings 3 and 4 and make the documented cancellation story true for every operation, not just the AI ones.
3. **Add CI.** One workflow matrixed over `ubuntu-latest` and `windows-latest` running `npm run check`, with FFmpeg installed so integration tests actually execute, and the skip count echoed. The Windows leg is the only place finding 2 and the platform-dependent link tests get real coverage.
4. **Close the five test gaps** listed above; each maps to a defect already demonstrated, so the tests are cheap and would have caught the bug.
5. **Consider making the FFmpeg budgets configurable** (`VIDEO_ANALYZER_FFMPEG_TIMEOUT_MS`, `VIDEO_ANALYZER_FFPROBE_TIMEOUT_MS`) and giving a timeout a distinct error code, so it is not reported as a corrupt file.
6. **Tidy the documents.** Correct the skip count, mark `findings-and-plan.md` as superseded, drop the dead `.gitignore` entry, and state the outbound-upload behaviour in the README's main body rather than only under Known Limitations.

## Resolution Status

All ten findings were resolved on 2026-11-11. `npm run check` is green — typecheck, oxlint, **204 passed / 1 skipped** (ten tests added), Prettier — and `npm run build` is clean.

| #   | Resolution                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `parseDotEnv` now scans for the closing quote and accepts only whitespace or a comment after it, so `KEY="value" # note` yields `value`. Two cases added to `dotenv.test.ts` (quoted + comment, and `#` inside a quoted value that also has a comment).                                                                       |
| 2   | When the launcher resolves to a batch shim it stages the payload in a temp file and forwards `--input-file`, so no user data reaches `cmd.exe`; the file is removed in a `finally`. `skill.test.ts` gains a Windows-only test that drives a stand-in `.cmd` shim with `a&b\|c^d.mp4`.                                         |
| 3   | `run()` in `ffmpeg.ts` classifies `signal.aborted`/`AbortError` first and raises the new `OPERATION_CANCELLED`; a killed child that hit its timeout now says `ffmpeg did not finish within N ms` instead of "ffmpeg failed", so neither is confused with corrupt media. Both paths have new tests in `extractFrames.test.ts`. |
| 4   | `downloadToFile` classifies abort before the generic branches: caller cancellation → `OPERATION_CANCELLED`, expired deadline → `DOWNLOAD_FAILED` naming the elapsed budget with a hint about `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`. Three `downloadToFile` tests added against real loopback servers.                           |
| 5   | `--input-file` read failures map to `INPUT_NOT_FOUND` (with a hint pointing at `--input`/stdin), matching what the Skill launcher already reported. Covered by a new CLI test.                                                                                                                                                |
| 6   | Parent-directory creation moved from `resolveTranscriptTarget` into `writeTranscript`, so validation creates nothing; a `CONFIG_MISSING` request now leaves no directories. Covered by a new pre-flight test.                                                                                                                 |
| 7   | README says 11 (measured: 1 skip with FFmpeg, 12 without).                                                                                                                                                                                                                                                                    |
| 8   | `get_video_info` sets `readOnly: true`, the `Operation.readOnly` doc explains the explicit opt-in, and `parity.test.ts` asserts the four read-only tools.                                                                                                                                                                     |
| 9   | `findings-and-plan.md` opens with a **Superseded** block listing the three changed decisions and pointing at the README and Skill references.                                                                                                                                                                                 |
| 10  | The `.video-analyzer/` entry is gone from `.gitignore`.                                                                                                                                                                                                                                                                       |

**Additional change that this work required:** cancellation had no honest code of its own, so `OPERATION_CANCELLED` was added to `ERROR_CODES` and is now raised by Gemini calls, FFmpeg runs, and downloads alike. `README.md`, `SKILL.md`, and `troubleshooting.md` document it, and the `GEMINI_TIMEOUT` section no longer claims to cover cancellation. This supersedes the pre-fix behaviour described in finding 3's impact paragraph.

Re-probed against the rebuilt `dist/`:

```text
dotenv  GEMINI_API_KEY="abc123" # aistudio   → "abc123"
        R="has # hash"                       → "has # hash"
download timeout (300 ms)                    → DOWNLOAD_FAILED: The download did not finish within 300 ms.
download aborted mid-stream                  → OPERATION_CANCELLED: The operation was cancelled.
ffmpeg run aborted after 150 ms              → OPERATION_CANCELLED (no encoder log in the hint)
cli --input-file ./nope.json                 → INPUT_NOT_FOUND: Input file not found: ./nope.json
transcribe_video, nested outputPath, no key  → CONFIG_MISSING, parent dir created: false
skill launcher via .cmd shim, "a&b|c^d.mp4"  → INPUT_NOT_FOUND (JSON survived the shell)
```
