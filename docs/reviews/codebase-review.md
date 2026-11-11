# Codebase Review

**Date:** 2026-11-11
**Revision:** `144e32f` (`main`, working tree differs only in this file)
**Scope:** all of [`src/`](../../src) (29 files, ~3.8k lines), [`tests/`](../../tests) (19 suites + 2 helpers, ~2.8k lines), [`skills/`](../../skills) (~620 lines of Skill and reference docs), [`README.md`](../../README.md), [`findings-and-plan.md`](../../findings-and-plan.md), and the build/lint/test configuration.

## Verdict

Green build and a green gate, clean layering, and an unusually consistent error contract. **No P1 defect and no exploitable remote vulnerability was found.**

Two P2 issues remain. One undermines what a green `npm run check` means: the suite silently depends on a pre-built, gitignored `dist/`, so a clean checkout fails and a linked global install can make the suite pass against an older build. The other is a local trust boundary: a `.env` in the working directory can set `PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`, the SSRF opt-in, and the Gemini key, so an untrusted repository can redirect subprocess execution or media uploads. The five P3s are contract and documented-behaviour gaps: raw `INTERNAL` errors for an unusable artifact directory, a paid-for transcript thrown away when the write fails (which the troubleshooting guide says does not happen), a broken `invoke.mjs help <operation>`, an upload cache that can never hit for URL inputs, and a README claim that every CLI call emits one JSON envelope.

All ten findings from the previous review (recorded against `1795c4e`, resolved in `144e32f`) were re-checked and remain fixed.

> **Updated 2026-11-11.** Findings 1–10 below were subsequently fixed; see [Resolution Status](#resolution-status). Adding CI was intentionally left out of that pass, so the CI recommendation still stands.

## Method

- Read every source file, every test suite and helper, the README, the Skill package, the three reference documents, and `findings-and-plan.md`. Compared every documented operation, setting, error code, limit, and exit behaviour against the implementation.
- Ran the full gate: `npm run check` (typecheck -> oxlint -> vitest -> prettier). **Result: green** - `tsc --noEmit` clean, oxlint clean, **204 passed / 1 skipped** across 19 files in ~6 s, Prettier clean. `npm run build` is also clean.
- Re-ran the suite with `FFMPEG_PATH` / `FFPROBE_PATH` pointing at missing binaries: **193 passed / 12 skipped (205)**, i.e. exactly the 11 extra skips the README documents.
- Probed runtime behaviour against `dist/`: an existing file passed as `extract_frames.outputDir`; a `.env` supplying `FFMPEG_PATH`/`FFPROBE_PATH`; the Skill launcher's `help <operation>`; the output shape of `--version`, `help`, and `list`; the Skill suite with `dist/` temporarily renamed; quoted `.env` values with trailing comments; an idle open stdin pipe on the CLI.
- Re-verified the previous review's ten resolutions, including re-running the probes that originally reproduced them.

## Findings Summary

| #   | Severity | Area              | Finding                                                                                                                                                                 |
| --- | -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2       | Verification      | `npm run check` never builds, but the Skill suite executes `dist/cli.js`: a clean checkout fails, and a linked global install can validate a stale build                |
| 2   | P2       | Security          | `.env` from the working directory sets arbitrary variables, including `PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`, `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS`, and `GEMINI_API_KEY` |
| 3   | P3       | Error contract    | An unusable artifact directory (`outputDir` or `VIDEO_ANALYZER_OUTPUT_DIR` that is a file) surfaces as `INTERNAL` with a raw `ENOTDIR` message                          |
| 4   | P3       | Data preservation | A transcript write failure throws away the generated transcript, while `troubleshooting.md` says the text is returned in the summary                                    |
| 5   | P3       | Skill launcher    | `node invoke.mjs help <operation>` treats the operation name as a JSON payload, so it prints general usage instead of the operation schema                              |
| 6   | P3       | Caching contract  | Upload reuse never applies to direct URL inputs: each call downloads into a new temp path, so the cache key always changes                                              |
| 7   | P3       | Docs accuracy     | README says every CLI call prints one JSON envelope; `--version` and `help` print plain text and `list` uses a different shape                                          |
| 8   | P4       | Docs accuracy     | Trailing-space key warning is false (the value is trimmed); `DEPENDENCY_MISSING` says "on PATH" even when an explicit path was configured                               |
| 9   | P4       | Result shapes     | `search_timestamp` omits `durationSeconds` on no-match/raw results and drops the model's prose; an out-of-range `offset` reports "0 frames"                             |
| 10  | P4       | Hygiene / polish  | No CI, unswept launcher payload files, `video-analyzer-output/` missing from `.prettierignore`, dead public surface, `fail()` uses `process.exit`                       |

## Findings

### P2: A green `npm run check` does not prove the current tree works

**Where:** [`package.json:33`](../../package.json:33) (`check` runs typecheck, lint, test, format - never `build`); [`tests/skill/skill.test.ts:89`](../../tests/skill/skill.test.ts:89) and [line 105](../../tests/skill/skill.test.ts:105) spawn `scripts/invoke.mjs`; [`invoke.mjs:43`](../../skills/video-analyzer/scripts/invoke.mjs:43) resolves `<repo>/dist/cli.js`, else a PATH install.

`dist/` is gitignored (`.gitignore:2`), so a fresh clone has no build. The Skill tests nevertheless execute the packaged launcher, whose first resolution candidate is the build:

```text
$ mv dist dist__probe
$ npx vitest run tests/skill/skill.test.ts
 FAIL  launcher lists operations without an MCP server
       Error: Command failed: node .../invoke.mjs list
       INTERNAL: The video-analyzer CLI produced no output.
 FAIL  launcher keeps payload metacharacters intact through the Windows cmd shim
       AssertionError: expected 'INTERNAL' to be 'INPUT_NOT_FOUND'
 Tests  2 failed | 6 passed (8)
```

**Impact:** on a clean checkout (or in CI without a prior build) `npm test` and `npm run check` fail for a reason that has nothing to do with the change. Worse, when the package is installed globally - on this machine `npm root -g` links straight back to the working tree - the same tests resolve whatever `dist/` happens to exist, so a green run can validate an older build than the source being edited. The suite's headline claim ("204 passed") therefore does not mean "the current source passes".

**Suggested fix:** make the gate self-contained. Either add `"pretest": "npm run build"` (or `npm run build &&` inside `check`), or stop spawning a build from the tests and import the CLI module in-process / build once into a temp directory. Add the build step to the README's `npm test` / `npm run check` instructions either way.

### P2: `.env` in the working directory is an unrestricted environment override

**Where:** [`config.ts:96`](../../src/config.ts:96) loads `.env`; [`dotenv.ts:79`](../../src/utils/dotenv.ts:79) copies every parsed key into `process.env`; [`ffmpeg.ts:84`](../../src/services/ffmpeg.ts:84) spawns the configured binary.

`.env` is loaded from `process.cwd()` and applied to the **real** process environment. Nothing restricts the keys, so a file in the directory the tool runs from can change:

- `FFMPEG_PATH` / `FFPROBE_PATH` - which executable `execFile` starts,
- `PATH` - which `ffmpeg`/`ffprobe` the defaults resolve to,
- `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true` - disabling the SSRF policy for direct downloads,
- `GEMINI_API_KEY` - when no real key is exported, routing the user's media to a different Gemini account.

Reproduced with a working directory containing only this `.env`:

```text
FFMPEG_PATH=definitely-not-a-real-ffmpeg
FFPROBE_PATH=definitely-not-a-real-ffprobe

$ node dist/cli.js get_video_info --input '{"videoPath":"…/sample.mp4"}'
{"ok":false,"error":{"code":"DEPENDENCY_MISSING",
 "message":"definitely-not-a-real-ffprobe is required but was not found on PATH.", …}}
```

**Impact:** the threat model is the documented Skill workflow: an agent runs `node ./scripts/invoke.mjs …` with the working directory set to a cloned repository, which may legitimately ship a `.env`. Such a file can point the tool at a bundled executable (local code execution with the user's privileges), relax the private-host block, or receive the user's media through an attacker-controlled API key. OS environment variables still win over `.env`, which limits but does not remove the vector - most users never set `FFMPEG_PATH`, `PATH`, or the private-host flag explicitly.

**Suggested fix:** treat `.env` as untrusted configuration. Allowlist the keys it may contribute (the `VIDEO_ANALYZER_*` limits, `GEMINI_MODEL`, `VIDEO_ANALYZER_OUTPUT_DIR`, optionally `GEMINI_API_KEY`), and refuse `PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`, and security toggles from it. If the convenience must stay, gate `.env` loading behind an explicit opt-in (for example `VIDEO_ANALYZER_LOAD_DOTENV=1`) and document that a `.env` in an untrusted repository is not safe to trust. Add a test that a `.env` setting `PATH` or `FFMPEG_PATH` is ignored.

### P3: An unusable artifact directory is reported as `INTERNAL`

**Where:** [`shared.ts:94`](../../src/operations/shared.ts:94) `createArtifactDir` calls `ensureDir` at [line 103](../../src/operations/shared.ts:103) with no error mapping; called from [`extractFrames.ts:156`](../../src/operations/extractFrames.ts:156).

`outputDir` (or `VIDEO_ANALYZER_OUTPUT_DIR`) is resolved and passed to `mkdir`. If any component is a file, or the directory cannot be created, the raw filesystem error escapes:

```text
$ node dist/cli.js extract_frames --input '{"videoPath":"…/sample.mp4","outputDir":"…/notadir.txt"}'
{"ok":false,"error":{"code":"INTERNAL",
 "message":"ENOTDIR: not a directory, mkdir '…\\notadir.txt'"}}
```

**Impact:** `INTERNAL` is documented as "a bug in the tool". This is a caller mistake with an obvious fix, and the message names a path but not the argument or setting that produced it. An agent relaying the result will tell the user to report a bug instead of changing `outputDir`. The message also carries raw OS text that varies by platform.

**Suggested fix:** wrap `ensureDir` inside `createArtifactDir` and raise `OUTPUT_FAILED` (or `INVALID_INPUT` for `ENOTDIR`) with a hint naming `outputDir` / `VIDEO_ANALYZER_OUTPUT_DIR` and `details: { dir, code }`. There is already an `OUTPUT_FAILED` code used by `transcribe_video`; reuse it and add a unit test.

### P3: A failed transcript write discards the transcript, contradicting the docs

**Where:** [`transcribeVideo.ts:215`](../../src/operations/transcribeVideo.ts:215) writes before returning; the success payload is built at [line 228](../../src/operations/transcribeVideo.ts:228). [`troubleshooting.md:141`](../../skills/video-analyzer/references/troubleshooting.md:141) says: "re-transcribing is not required to know the text, which is also returned in the response summary."

The write is on the success path:

```ts
if (target && !noSpeech) {
  await writeTranscript(target, `${text}\n`, input.overwrite ?? false)   // throws
  artifacts.push({ … })
}
…
return { summary: noSpeech ? 'No audible speech detected.' : text, … }   // never reached
```

**Impact:** when the write fails (`ENOSPC`, `EACCES`, a read-only volume, a parent that is a file), the caller gets `OUTPUT_FAILED` and nothing else. The transcript - which may represent minutes of Gemini processing and a non-trivial API bill - is unrecoverable, and the troubleshooting guide tells the user it is in the response. The existing test asserts the failure and that no file was written, but not the recovery path.

**Suggested fix:** treat the transcript as the primary result. Catch the write failure and return the text in `summary`/`data` with a warning that names the write problem (or add `details.transcript` to the error). Correct the troubleshooting paragraph either way. Cap any inline text to keep the envelope bounded.

### P3: `invoke.mjs help <operation>` is broken

**Where:** [`invoke.mjs:91`](../../skills/video-analyzer/scripts/invoke.mjs:91) collects flags, then treats the **first positional argument** as the JSON payload at [line 105](../../skills/video-analyzer/scripts/invoke.mjs:105); the usage block advertises `node invoke.mjs help [operation]` at [line 13](../../skills/video-analyzer/scripts/invoke.mjs:13). [`troubleshooting.md:106`](../../skills/video-analyzer/references/troubleshooting.md:106) tells users to run exactly that.

```text
$ node skills/video-analyzer/scripts/invoke.mjs help extract_frames
video-analyzer — Gemini-powered video and audio analysis        # general usage
Usage: …

$ node dist/cli.js help extract_frames
extract_frames — Extract Frames
…
Input schema: { … }                                             # expected
```

The launcher forwards `--input extract_frames`; the CLI's help branch consumes it as a flag value, so `rest[0]` is empty and it falls back to general usage.

**Impact:** the documented recovery step for `INVALID_INPUT` (print the operation schema) does not work through the Skill, which is the interface agents use. The agent cannot discover argument names without reading `operations.md`, and an agent following the troubleshooting guide reports the wrong information.

**Suggested fix:** only infer a payload when the operation is not `help` or `list`; forward operands positionally for those two. Add a launcher test asserting the operation name appears in `help extract_frames` output.

### P3: Upload reuse can never happen for direct URL inputs

**Where:** [`mediaInput.ts:87`](../../src/services/mediaInput.ts:87) creates a new temp directory per resolution; [`gemini.ts:247`](../../src/services/gemini.ts:247) keys the upload cache on `path + size + mtime`; [`shared.ts:12`](../../src/operations/shared.ts:12) documents "One Gemini service per process/config so upload reuse survives across calls in a long-lived MCP session."

Every direct URL resolution downloads to `mkdtemp()/source.media`, so the path and mtime differ on every call. Two `analyze_video` calls on the same URL in one MCP session therefore download the file twice and upload it twice, even though the cache works exactly as designed for local files.

**Impact:** repeated questions about the same remote recording pay the download, the upload, and the Gemini processing wait again. On the default 2 GB limit and a slow link this is the most expensive part of the call, and the code comment promises otherwise. It is also a quota and bandwidth surprise for MCP sessions, where repeated calls are the normal pattern.

**Suggested fix:** key the cache on the source identity (URL plus `ETag`/`Last-Modified`/`Content-Length`) and keep the downloaded file for the session, or at least document that reuse is local-only. `sweepStaleTempDirs` already handles abandoned temp directories, so a session-scoped download directory fits the existing cleanup model.

### P3: README's "every call prints one JSON envelope" is inaccurate

**Where:** [`README.md:209`](../../README.md:209), immediately after the CLI examples that include `--version` and `help`.

Only operation invocations and `list` produce JSON. `--version` prints `0.1.0` and `help` prints usage text; `list` returns `{ ok, operations }` without `operation`, `summary`, `warnings`, `images`, or `artifacts`. A script or agent that follows the sentence and pipes every command into `JSON.parse` breaks on two of the five examples.

Also in [`cli.ts:118`](../../src/adapters/cli.ts:118), the `Environment:` block lists `VIDEO_ANALYZER_MAX_FRAMES`, `REQUEST_TIMEOUT_MS`, and others but omits `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS` and `VIDEO_ANALYZER_POLL_INTERVAL_MS`, both of which the README and `.env.example` document and the code reads.

**Suggested fix:** say "Operations and `list` print JSON; `--version` and `help` print plain text", and add the two missing settings to `CLI_USAGE`. A one-line test over the documented CLI examples would keep this honest.

### P4: Small documentation accuracy issues

- **Trailing spaces are not fatal.** [`README.md:168`](../../README.md:168) and `configuration.md` say a quoted value or a trailing space makes the key invalid. [`readString`](../../src/config.ts:75) trims, so a trailing space is harmless for the CLI; surrounding quotes in a real environment variable are not stripped. Say "quotes are not stripped from environment variables; a trailing space is trimmed".
- **"On PATH" when a path was given.** [`ffmpeg.ts:84`](../../src/services/ffmpeg.ts:84) always says `<binary> is required but was not found on PATH`, even when the user set `FFPROBE_PATH` explicitly (reproduced above). Name the configured path and the setting.
- **"Lower ceiling".** `configuration.md` describes scene mode as using `VIDEO_ANALYZER_MAX_FRAMES` as a "lower ceiling"; it is a tighter/clamped ceiling. Minor wording.
- **Cleanup is best-effort.** `operations.md` says the artifact folder "is removed" on failure; `removeDir` swallows errors, so "is removed on a best-effort basis" is accurate.

### P4: Result-shape inconsistencies

- **`search_timestamp`** omits `durationSeconds` from the no-match ([line 115](../../src/operations/searchTimestamp.ts:115)) and unparsed-answer ([line 126](../../src/operations/searchTimestamp.ts:126)) branches, although the parsed branch includes it ([line 148](../../src/operations/searchTimestamp.ts:148)). On `NO_MATCH` the model's prose is also dropped, even though the raw-answer branch preserves it. Timestamps are not checked against the clip duration, so a model reply of `MATCH 999 …` for a 20 s clip is reported verbatim.
- **`extract_frames`** with `offset` at or beyond `totalFrames` returns `page = []`, `hasMore: false`, and the summary "Extracted 0 frame(s) …" while `data.totalFrames` is non-zero ([lines 252-276](../../src/operations/extractFrames.ts:252)). Say "no frames on this page; there are N total" instead.
- **`transcribe_video`** treats a whitespace-only model response as a successful empty transcript: `generate()` only rejects a falsy `response.text`, and `trim()` happens afterwards, so `summary` can be `''`. Treat an empty trimmed transcript as `NO_SPEECH`.

**Suggested fix:** normalise these shapes and add the duration/range check; each is a few lines.

### P4: Hygiene and packaging polish

- **No CI.** There is no `.github/` directory. The repository history is review-first, and finding 1 and the Windows-only launcher test depend on CI to stay honest.
- **Unswept launcher payload files.** `invoke.mjs` stages payloads as `video-analyzer-input-<pid>-<uuid>.json`; [`sweepStaleTempDirs`](../../src/utils/fsUtils.ts:22) only removes **directories**, so a killed launcher leaves the file (which contains media paths and questions) in the temp directory. Extend the sweep to that filename prefix.
- **`.prettierignore`** does not list `video-analyzer-output/`, so `prettier --check .` traverses every extracted frame directory. Add it (`dist/` is already there).
- **Dead public surface.** [`mediaInput.ts:67`](../../src/services/mediaInput.ts:67) takes an `override` argument no caller passes; [`net.ts:226`](../../src/utils/net.ts:226) exposes `DownloadOptions.headers` that no caller sets; [`types.ts:8`](../../src/operations/types.ts:8) allows `Artifact.kind` values (`video`, `frame`, `metadata`) that no operation produces; [`fsUtils.ts:49`](../../src/utils/fsUtils.ts:49) dynamically imports `node:fs/promises` inside `ensureDir` on a hot path while every other builtin is imported statically.
- **`fail()` can truncate its envelope.** [`invoke.mjs:29`](../../skills/video-analyzer/scripts/invoke.mjs:29) writes JSON and calls `process.exit(1)` immediately. On Windows, stdout to a pipe is asynchronous, so the envelope can be lost on the way out. Set `process.exitCode = 1` and return, as the rest of the script already does.
- **Packaging metadata.** `package.json` has no `repository`, `bugs`, or `homepage`; add them before publishing.

## Previous Review Status

All ten findings from the review recorded against `1795c4e` are fixed in `144e32f` and were re-checked:

| #   | Previous finding                                      | Verification                                                                                                                     |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Quoted `.env` value with a trailing comment           | `parseDotEnv('A="quoted value" # note')` now returns `{"A":"quoted value"}`; covered by `dotenv.test.ts`                         |
| 2   | Windows `.cmd` shim corrupting payloads               | The launcher stages the payload in a temp file and forwards `--input-file`; the Windows-only shim test passes                    |
| 3   | FFmpeg cancellation reported as media failure         | `run()` classifies abort first and raises `OPERATION_CANCELLED`; two `extractFrames` tests cover cancel and the internal timeout |
| 4   | Download timeout/cancel misclassified                 | `downloadToFile` classifies abort and deadline before the generic branches; three loopback tests cover it                        |
| 5   | Missing `--input-file` reported as `INTERNAL`         | The CLI wraps the read and reports `INPUT_NOT_FOUND`; `cli.test.ts` asserts the code and hint                                    |
| 6   | `transcribe_video` created directories before failing | `ensureDir` moved into `writeTranscript`; the pre-flight test asserts no directory survives `CONFIG_MISSING`                     |
| 7   | README skip count wrong                               | Measured: 1 skip with FFmpeg, 12 without - exactly the documented 11 extra                                                       |
| 8   | `get_video_info` not marked read-only                 | `readOnly: true` is set explicitly and `parity.test.ts` asserts the four read-only tools                                         |
| 9   | `findings-and-plan.md` stale                          | It now opens with a **Superseded** block listing the changed decisions and pointing at the README and Skill references           |
| 10  | Dead `.video-analyzer/` ignore entry                  | Removed from `.gitignore`                                                                                                        |

## Architecture And Quality

**Strengths**

- **One source of truth per concern.** [`registry.ts`](../../src/operations/registry.ts) owns names, titles, schemas, categories, and handlers; both adapters iterate it, and [`parity.test.ts`](../../tests/contract/parity.test.ts) enforces name, schema identity, description, read-only, and destructive parity. The `satisfies readonly Operation<z.ZodTypeAny>[]` constraint keeps the inferred `OperationName` union honest.
- **Uniform, typed error contract.** Every expected failure is a [`VideoAnalyzerError`](../../src/utils/errors.ts:43) with a stable code from a closed union, an optional hint, and structured `details`; adapters render it as JSON (CLI) or text (MCP) without leaking stacks or secrets. Findings 3, 4, 7 and 8 are visible precisely because the contract is otherwise so consistent.
- **Deterministic services.** [`GeminiMediaService`](../../src/services/gemini.ts:223) takes injectable `api`, `now`, and `sleep`; [`runWithBounds`](../../src/utils/abort.ts:32) makes cancellation and deadlines testable without real timers; FFmpeg runs through `execFile` with argument arrays, so there is no shell and no injection surface.
- **Explicit storage invariants.** "One artifact directory per request" is documented at the type ([`FrameExtractionOptions.outDir`](../../src/services/ffmpeg.ts:176)), enforced for the modes that list the directory, and covered by unit and integration tests. A failed extraction removes its partial folder.
- **Budgets enforced during production, not after.** `-frames:v` caps interval extraction inside FFmpeg, `resolveFrameBudget` refuses to return `0` (which FFmpeg would read as unlimited), and `extractFramesAtTimestamps` stats every output instead of trusting the exit code.
- **Strictness that pays off.** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, and `isolatedModules` are enabled and satisfied rather than cast around.
- **Docs as part of the product.** README, `SKILL.md`, and the references agree with the code on settings, error codes, exit behaviour, and Windows quirks, and a test enforces that every operation is mentioned in `SKILL.md`. Findings 4, 7, and 8 are the exceptions.

**Weaknesses**

- **Process-global mutable state.** [`sharedService`](../../src/operations/shared.ts:15) and the logger [`sink`](../../src/utils/logger.ts:30) are module-level singletons with test-only reset hooks. Correct for the two shipped entry points; two embedders with different configs or sinks in one process would interfere, and the public export surface does not warn about it.
- **Validation runs twice per call.** Each adapter parses the payload, then [`executeOperation`](../../src/operations/execute.ts:47) parses it again. Harmless and justified as an embedder guarantee, but it is real work on every MCP and CLI call.
- **Hard-coded FFmpeg budgets.** [`FFMPEG_TIMEOUT_MS`](../../src/services/ffmpeg.ts:10) (10 min) and [`FFPROBE_TIMEOUT_MS`](../../src/services/ffmpeg.ts:11) (60 s) are constants while every Gemini deadline is configurable; a scene extraction over a feature-length file can hit the former.
- **Two independent budgets are coupled.** The download deadline is `max(VIDEO_ANALYZER_REQUEST_TIMEOUT_MS, 60 s)`, so allowing a large download on a slow link also gives every Gemini call a much longer deadline. A dedicated download timeout would separate them (previously noted; still true).
- **No CI and no type-aware linting.** `oxlint` has no `no-floating-promises` or `no-misused-promises`, and the README explains why; a CI job would at least pin the build/test/format claims.

## Security Assessment

The network boundary remains the strongest part of the codebase.

- **SSRF defence is layered.** [`assertSafeHttpUrl`](../../src/utils/net.ts:153) rejects non-HTTP(S) schemes, embedded credentials, loopback/metadata names, and every private or reserved address (IPv4, IPv6, IPv4-mapped, NAT64), and every redirect hop is revalidated. Resolution failures fail closed.
- **Size bounds are enforced twice.** `Content-Length` is checked before the body is read and the byte count is checked while streaming, so a chunked response cannot exceed `maxBytes`.
- **Command execution is safe.** FFmpeg/FFprobe run via `execFile` with argument arrays; input paths are resolved to absolute paths first, so a `videoPath` beginning with `-` cannot be read as an option.
- **Source-media protection is thorough** for `transcribe_video`: canonical-path comparison (covering `..`, symlinks, casing) plus device/inode comparison (covering hard links) before upload, backed by an exclusive-create `wx` write so a target that appears after validation still cannot be clobbered.
- **Secrets are never logged.** Diagnostics go to stderr or the MCP logging channel; the key is only handed to the SDK.
- **Residual risk is documented honestly.** The resolve-to-connect window is not pinned, so DNS rebinding remains theoretically possible; the README says so instead of over-claiming.

**The one new security concern is the local trust boundary in finding 2.** The network layer is hardened while the file that usually sits next to the code - `.env` - can disable parts of it and choose the binaries that run. This is worth fixing before the network edge is worth more effort.

**Worth stating more plainly in the README:** AI operations upload user media to Google (currently only under "Known Limitations"), and `transcribe_video` / `extract_frames` write to caller-chosen paths, so an agent driving them is as trustworthy as its path choice.

## Test Assessment

204 passing, 1 skipped, ~6 s - fast enough to run on every save. The suite is behaviour-oriented and the assertions are specific.

| Area                         | Coverage | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini timeouts/cancellation | Strong   | Stalled generation, status poll and upload; pre-aborted signal; upload time counted against the processing deadline; signal and deadline handed to the SDK; MCP cancellation propagation; a shared upload surviving its initiator's cancellation                                                                                                                                               |
| Frame budgets                | Strong   | Budget passed as `-frames:v`, on-disk count capped, uncapped config still bounded, paging does not change the produced count, sub-minimum interval rejected before any process runs, `resolveFrameBudget` edge cases                                                                                                                                                                           |
| Output isolation             | Strong   | Reused directories report only their own frames; pre-populated directories rejected without invoking FFmpeg; integration test reuses one parent directory                                                                                                                                                                                                                                      |
| Source overwrite protection  | Strong   | Relative spelling, `file://`, symlink, hard link, symlinked parent, existing file, directory target, exclusive-create race                                                                                                                                                                                                                                                                     |
| SSRF / download policy       | Strong   | Private and reserved ranges, IPv6 forms, credentials, platform-page rejection, opt-in behaviour, declared and streamed size limits, redirect revalidation, timeout and cancellation classification                                                                                                                                                                                             |
| CLI / MCP parity             | Strong   | Names, schema object identity, descriptions, read-only and destructive classification, forbidden capability names, a real in-memory MCP client                                                                                                                                                                                                                                                 |
| Skill launcher               | Good     | Listing, missing input, and the Windows `.cmd` metacharacter path. **Gaps:** the suite depends on a prior build (finding 1), and `help <operation>` is untested and broken (finding 5)                                                                                                                                                                                                         |
| **Gaps**                     | -        | (a) no test for an unusable `outputDir` / `VIDEO_ANALYZER_OUTPUT_DIR` (finding 3); (b) no assertion that the transcript survives a failed write (finding 4); (c) no test that `.env` cannot change `PATH`/`FFMPEG_PATH` or the SSRF opt-in (finding 2); (d) no upload-cache test for URL inputs (finding 6); (e) no test of the documented `--version`/`help`/`list` output shapes (finding 7) |

The integration and Skill suites skip themselves when FFmpeg is missing; the README's "11 tests" is accurate (verified), and the always-skipped symlink case on Windows is the twelfth skip. Nothing surfaces the skip count in CI, so a run without FFmpeg still looks green.

## Verification Performed

```text
npm run check
  typecheck  tsc -p tsconfig.json --noEmit        clean
  lint       oxlint src tests skills              clean
  test       vitest run                           19 files, 204 passed, 1 skipped (205), ~6 s
  format     prettier --check .                   clean

npm run build                                     clean (dist/cli.js, dist/mcp.js)

npx vitest run tests/skill tests/contract          15 passed

FFMPEG_PATH=missing FFPROBE_PATH=missing npx vitest run
                                                   193 passed, 12 skipped (19 files)
```

Manual probes against the built `dist/` (temp directories only, no repository writes):

- `extract_frames` with `outputDir` set to an existing file -> `INTERNAL: ENOTDIR: not a directory, mkdir '…'` (finding 3).
- Working directory containing `.env` with `FFPROBE_PATH=definitely-not-a-real-ffprobe` -> `DEPENDENCY_MISSING` naming the injected binary (finding 2).
- `node skills/video-analyzer/scripts/invoke.mjs help extract_frames` -> general usage; the same command on `dist/cli.js` prints the operation schema (finding 5).
- `node dist/cli.js --version` -> `0.1.0`; `help get_video_info` -> plain text (finding 7).
- Skill suite with `dist/` renamed -> 2 of 8 tests fail with `INTERNAL: The video-analyzer CLI produced no output` (finding 1).
- `.env` parsing of `A="quoted value" # trailing note` -> `{"A":"quoted value"}` (previous finding 1 resolved).
- CLI run with an idle open stdin pipe -> exits normally with the error envelope (previous stdin concern resolved).
- Full suite with FFmpeg hidden -> 11 additional skips, matching the README.

## Recommendations

1. **Add CI.** One workflow matrixed over `ubuntu-latest` and `windows-latest` running `npm run check`, with FFmpeg installed so integration tests actually execute, and the skip count echoed. The Windows leg is the only place the `.cmd` shim handling and the platform-dependent link tests get real coverage. (The build step the gate needs is now part of `npm test` via `pretest`, so the workflow itself is a thin wrapper.)
2. **Keep `.env` a convenience, not a trust grant.** The allowlist in `DOTENV_KEYS` is the enforcement point; any new setting added to configuration should be considered deliberately before it is allowed there.
3. **Separate the download and Gemini budgets.** The download deadline is still `max(VIDEO_ANALYZER_REQUEST_TIMEOUT_MS, 60 s)`, so raising it for a large download also lengthens every Gemini call; a dedicated download timeout would decouple them.
4. **Pin the new contracts with tests as they evolve:** the `.env` allowlist, `OUTPUT_FAILED` on an unusable artifact root, the transcript-survives-write-failure path, the launcher's `help`/`list` operands, and the URL upload identity.

## Resolution Status

All ten findings were resolved on 2026-11-11, **except adding CI**, which is deliberately out of scope for this pass. `npm run check` is green — typecheck, oxlint, **225 passed / 1 skipped** (21 tests added), Prettier — and `npm run build` is clean.

| #   | Resolution                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `"pretest": "npm run build"` makes `npm test` and `npm run check` build before the Skill suite drives `dist/`. The Skill suite also fails with an explicit "run `npm run build`" message instead of "produced no output". Verified by renaming `dist/`: `npm test` rebuilt it and passed 225/1.                                                                             |
| 2   | `.env` is now an allowlist: `applyDotEnv` / `DOTENV_KEYS` accepts only `GEMINI_API_KEY`, `GEMINI_MODEL`, and the `VIDEO_ANALYZER_*` settings; `PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`, and `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` are ignored. Verified: a working directory with a `.env` setting `FFPROBE_PATH`/`PATH` no longer changes the binary or the search path.       |
| 3   | `createArtifactDir` maps a failed `mkdir` to `OUTPUT_FAILED` naming `outputDir` (or `VIDEO_ANALYZER_OUTPUT_DIR`) with `details.code`, instead of leaking `ENOTDIR` as `INTERNAL`.                                                                                                                                                                                           |
| 4   | A failed transcript write no longer discards the text: the operation returns it in `summary`, adds a warning naming the target and OS error code, and reports `data.outputWritten: false`. `troubleshooting.md` and `operations.md` were corrected to match.                                                                                                                |
| 5   | The launcher forwards `help`/`list` operands positionally instead of folding them into `--input`, and `fail()` flushes both streams before exiting. `invoke.mjs help extract_frames` now prints the operation schema.                                                                                                                                                       |
| 6   | `ResolvedMedia.cacheKey` identifies a direct download by origin (`direct:<finalUrl>:<bytes>`), and `EnsureUploadedParams.cacheKey` overrides the path-based key, so a repeated URL in one session reuses the upload. Threaded through `statForUpload` into all four AI operations.                                                                                          |
| 7   | README states that operations and `list` print JSON while `--version` and `help` print plain text; `CLI_USAGE` gained the upload/poll settings and the `.env` restriction.                                                                                                                                                                                                  |
| 8   | Corrected the trailing-space wording (it is trimmed; quotes in a real variable are kept), and `DEPENDENCY_MISSING` now names a configured binary path instead of saying "on PATH". Also fixed "lower ceiling" → "tighter ceiling" and described artifact cleanup as best-effort.                                                                                            |
| 9   | `search_timestamp` always includes `durationSeconds` and `raw`, and warns when a reported timestamp is past the clip. `extract_frames` says when an `offset` is past the produced set instead of "Extracted 0 frame(s)". A whitespace-only reply is treated as `NO_SPEECH`.                                                                                                 |
| 10  | `video-analyzer-output/` is in `.prettierignore`; the temp sweep now also removes stale launcher payload files; `package.json` gained `repository`/`bugs`/`homepage`; dead surface was removed (`DownloadOptions.headers`, `resolveMimeType`'s unused override, unused `Artifact.kind` values); `ensureDir` imports `mkdir` statically. **CI was intentionally not added.** |

Runtime re-checks against the rebuilt `dist/`:

```text
.env with FFPROBE_PATH + PATH + ALLOW_PRIVATE_HOSTS  → ignored; probe used the real ffprobe
extract_frames, outputDir is a file                  → OUTPUT_FAILED (hint names outputDir, details.code ENOTDIR)
extract_frames, offset 9 past 3 produced frames       → "No frames on this page: offset 9 is past the 3 frame(s)…"
FFPROBE_PATH=C:\definitely\missing\ffprobe.exe        → DEPENDENCY_MISSING "The configured media binary was not found: …"
invoke.mjs help extract_frames                        → "extract_frames — Extract Frames … Input schema:"
invoke.mjs (no operation)                             → complete INVALID_INPUT envelope on stdout, exit 1
rm -rf dist && npm test                               → pretest rebuilt dist; 225 passed / 1 skipped
```
