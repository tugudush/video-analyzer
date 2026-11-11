# Codebase review

Reviewed 2026-11-12 against commit `4cf9825` and the working tree. This is a
correctness, reliability, and maintainability review, not a penetration test.
The findings describe the code as reviewed; their source links point at that
state, so line numbers have shifted since. The previous review (commit `927c5fe`
and earlier) is retained in git history.

## Remediation status — 2026-11-12

Five of the six findings are closed; the CI workflow is deliberately left open.

- **P2 (timer overflow):** `MAX_TIMER_MS` and `clampTimerMs` landed in
  [abort.ts](../../src/utils/abort.ts#L18) and are now applied by every timer this
  codebase starts: `runWithBounds`, `downloadToFile`, the SDK upload binding, and
  the poll sleep. The three millisecond settings are additionally validated in
  [config.ts](../../src/config.ts#L45), so the documented surface reports
  `INVALID_INPUT` naming the accepted range instead of the runtime clamping
  silently. Regression tests: a `runWithBounds` deadline one millisecond above the
  ceiling must not fire immediately, a download with that budget must complete,
  and `loadConfig` must reject `2147483648` for each of the three settings while
  accepting `2147483647`.
- **P2 (launcher path):** documentation now states that
  `VIDEO_ANALYZER_CLI_PATH` is environment-only and that the Skill launcher never
  reads `.env` ([README](../../README.md#L272),
  [configuration.md](../../skills/video-analyzer/references/configuration.md#L50),
  [`.env.example`](../../.env.example#L27)), and the CLI usage text lists which
  keys `.env` may actually set. The allowlist is unchanged on purpose: a
  repository-supplied file must not choose the executable the launcher spawns.
  `VIDEO_ANALYZER_CLI_PATH` joined the `.env` trust-boundary test so the intent is
  pinned.
- **P3 (dead cache fields):** `sizeBytes` and `mtimeMs` are gone from
  `EnsureUploadedParams` and `CachedUpload`; `statForUpload` became the
  synchronous [`uploadIdentityFor`](../../src/operations/shared.ts#L101), which
  carries only the content-derived `cacheKey` and the retention hook. The
  `cacheKey` contract now states that it must be derived from the bytes, because
  nothing re-checks the file.
- **P3 (scene truncation):** resolved as a documentation defect, not a behaviour
  change. On re-examination the pre-fix rule is the correct one: the detection
  pass requests one frame beyond the budget, so counting detected frames (not
  unique timestamps) is what proves the pass was cut short, and a duplicated
  `pts_time` must not hide an unobserved frame behind the ceiling. The rule now
  says so in place ([ffmpeg.ts](../../src/services/ffmpeg.ts#L623)), and the
  existing duplicate-timestamp test already covered it.
- **P3 (double validation):** `executeOperation` is the single owner.
  [mcpTools.ts](../../src/adapters/mcpTools.ts#L88) and
  [cli.ts](../../src/adapters/cli.ts#L310) pass the raw payload through, and the
  adapter test now asserts both the delegation and the unchanged
  `INVALID_INPUT` result.

| Finding                                                      | Severity | Status      |
| ------------------------------------------------------------ | -------- | ----------- |
| Out-of-range timeout settings become instant failures        | P2       | ✅ Resolved |
| `VIDEO_ANALYZER_CLI_PATH` is documented but silently ignored | P2       | ✅ Resolved |
| Upload cache stores size/mtime and never checks them         | P3       | ✅ Resolved |
| Scene truncation flag mixes pre/post-dedupe detection counts | P3       | ✅ Resolved |
| Arguments are validated twice per call in both adapters      | P3       | ✅ Resolved |
| No CI workflow despite the documented `npm run check` gate   | P3       | Open        |

## Summary

One shared operation registry keeps the CLI and MCP interfaces structurally
identical, and both adapters delegate validation, logging, cancellation, and
error shaping to the same core. Media handling (ffprobe classification, frame
budgets, paging manifests, temp-directory ownership, per-hop URL validation) is
defensive and unusually well reasoned, and the test suite is broad for a project
of this size: 22 files, 315 passing tests, with generated media fixtures instead
of committed binaries.

No release blocker was found. The two P2 findings were both in the
**configuration surface**, not in media or provider handling: one setting could
silently invert into an instant failure, and another was documented as
`.env`-eligible while being rejected by the allowlist. The P3 findings were a dead
cache contract, an off-by-source truncation flag, duplicated validation, and a
missing CI workflow.

Severity: **P1** blocks a core capability; **P2** is a meaningful defect under
the stated conditions; **P3** is lower impact or maintainability.

## Previous review — re-verified

The four findings recorded in the previous entry were re-checked rather than
assumed to hold:

| Previous finding                              | Verification                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — Gemini upload URL and headers            | [`uploadFile`](../../src/services/gemini.ts#L152) sends no request-level `httpOptions`; the real-SDK transport test still asserts `/upload/v1beta/files` and the `x-goog-upload-*` headers. |
| P2 — Upload cancellation leaves transfer live | [`bindUpload`](../../src/services/gemini.ts#L107) plus the `AsyncLocalStorage` fetch wrapper still bind every chunk; three transport tests cover cancel and deadline.                       |
| P2 — Audio cover art treated as video         | [`isAttachedPicture`](../../src/services/ffmpeg.ts#L62) still gates stream selection, and all four extraction modes map the probed index.                                                   |
| P3 — Remote image bypasses media validation   | [`resolveDirect`](../../src/services/mediaInput.ts#L89) still requires a media MIME type from either the header or the URL path.                                                            |

All four remain fixed and covered by tests.

## Findings

### P2 — An out-of-range timeout setting turns into an immediate failure

- **Status:** ✅ **Resolved.** `clampTimerMs` now bounds every delay this codebase
  hands to a timer, and `loadConfig` rejects the three millisecond settings above
  `MAX_TIMER_MS` with a message naming the accepted range. Covered by
  `tests/unit/abort.test.ts`, `tests/unit/net.test.ts`, and `tests/unit/config.test.ts`.
- **Evidence:** [`readInt`](../../src/config.ts#L44) accepts any integer at or
  above `min` and has no upper bound, so `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`,
  `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`, and `VIDEO_ANALYZER_POLL_INTERVAL_MS` pass
  values of any size straight through. Those values reach `setTimeout` in
  [`runWithBounds`](../../src/utils/abort.ts#L48), in
  [`bindUpload`](../../src/services/gemini.ts#L107), and in the service's `sleep`
  helper, and `AbortSignal.timeout` in
  [`downloadToFile`](../../src/utils/net.ts#L269).
- **Reproduced:** Node clamps a delay above `2^31 - 1` ms to **1 ms**:

  ```text
  timeoutMs=2147483647 (2^31-1) work completed after 5010 ms
  timeoutMs=2147483648 (2^31)   rejected with deadline after 12 ms   (TimeoutOverflowWarning)
  timeoutMs=3000000000          rejected with deadline after 15 ms   (TimeoutOverflowWarning)
  ```

  End to end over the CLI, with a local HTTP server serving a 3-second MP4 and
  `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true`:

  ```text
  default timeout      => exit 0  OK mov,mp4,m4a,3gp,3g2,mj2
  REQUEST_TIMEOUT=3e9  => exit 1  DOWNLOAD_FAILED "The download did not finish within 3000000000 ms."
  ```

- **Impact:** Raising a timeout is the documented remedy for `GEMINI_TIMEOUT`
  and `DOWNLOAD_FAILED`, and the hints say exactly that
  ([`requestTimeout`](../../src/services/gemini.ts#L296),
  [`classifyDownloadFailure`](../../src/utils/net.ts#L278)). A user who sets an
  "effectively unlimited" value (anything over ~24.8 days) gets the opposite of
  what they asked for: the operation fails immediately, at full speed, with a
  message naming the value they set. The failure is of the _deadline_ kind, so it
  is indistinguishable from a genuinely slow provider.
- **Recommendation:** Bound the timeout settings in `readInt` (or clamp in
  `runWithBounds` / `downloadToFile` and treat values at or above the 32-bit
  limit as "no deadline"). Add a config test that rejects or clamps
  `2147483648`, and keep the existing hint text accurate for the accepted range.

### P2 — `VIDEO_ANALYZER_CLI_PATH` is documented as `.env`-eligible but silently ignored

- **Status:** ✅ **Resolved.** Both docs and the CLI usage text now state that the
  launcher path is environment-only and that the launcher never reads `.env`; the
  allowlist stays closed to it, and a test pins that.
- **Evidence:** The configuration table lists
  [`VIDEO_ANALYZER_CLI_PATH`](../../README.md#L272) among the variables, and the
  paragraph beneath it says a `.env` file "may only set `GEMINI_API_KEY`,
  `GEMINI_MODEL`, and the `VIDEO_ANALYZER_*` settings above"
  ([README.md](../../README.md#L277)). The Skill reference repeats the same rule
  and lists the variable again under Diagnostics
  ([configuration.md](../../skills/video-analyzer/references/configuration.md#L47),
  [same file](../../skills/video-analyzer/references/configuration.md#L130)).
  But [`DOTENV_KEYS`](../../src/config.ts#L88) omits it, and
  [`invoke.mjs`](../../skills/video-analyzer/scripts/invoke.mjs) never reads a
  `.env` file at all — it reads `process.env` only.
- **Reproduced:** `applyDotEnv` against a scratch `.env` containing six keys:

  ```text
  applied: [ 'GEMINI_API_KEY', 'VIDEO_ANALYZER_LOG_LEVEL', 'VIDEO_ANALYZER_OUTPUT_DIR' ]
  CLI_PATH seen by CLI config: undefined
  ```

  (`VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` and `FFMPEG_PATH` were also rejected, as
  documented.) A grep of the launcher for `dotenv`, `.env`, and `loadConfig`
  returns nothing.

- **Impact:** Choosing a build for the launcher is the documented fix for "the
  Skill cannot find the CLI", and it is the only remedy that avoids a global
  install. A user who follows the `.env` wording — the same wording used for every
  other setting — gets a silently ignored value, and the launcher falls back to a
  checkout-relative build or a PATH shim instead of the build that was chosen. The
  failure then looks like "the CLI produced no output" rather than a configuration
  mistake.
- **Recommendation:** Do **not** add the key to the allowlist: letting a
  repository-supplied file choose the executable the launcher spawns is the exact
  risk the allowlist exists to prevent. Fix the documentation instead — mark it
  "Environment only — a `.env` file cannot set it" in both tables, and say
  explicitly that the Skill launcher does not read `.env` (only the CLI and MCP
  server do).

### P3 — Upload cache stores size and mtime but never checks them

- **Status:** ✅ **Resolved.** The fields are removed from `CachedUpload` and
  `EnsureUploadedParams`, and `statForUpload` became the synchronous
  `uploadIdentityFor`, which no longer stats the file. `cacheKey` is documented as
  content-derived, which is the only thing the cache actually relies on.
- **Evidence:** [`CachedUpload`](../../src/services/gemini.ts#L240) carries
  `sizeBytes` and `mtimeMs`, both populated in
  [`uploadAndWait`](../../src/services/gemini.ts#L479), and
  [`EnsureUploadedParams`](../../src/services/gemini.ts#L265) requires the caller
  to supply them. The only cache decision in
  [`ensureUploaded`](../../src/services/gemini.ts#L365) is `expiresAtMs` plus a
  liveness check of the remote file; the recorded size and mtime are never read.
  [`statForUpload`](../../src/operations/shared.ts#L101) performs a `stat` on
  every AI call to produce them.
- **Impact:** The fields imply a staleness contract that does not exist. An
  embedder that passes a `cacheKey` for a path that can change will have the
  second, different file reused from the first upload without any size or mtime
  comparison — the cache comment says only content-derived keys are safe, but the
  type suggests otherwise. It also costs one filesystem call per Gemini request
  for data nothing consumes.
- **Recommendation:** Either compare `sizeBytes`/`mtimeMs` for keyed entries and
  drop the entry on mismatch, or delete both fields (and the `stat` in
  `statForUpload`) and document `cacheKey` as "must be content-derived".

### P3 — Scene-mode truncation flag mixes pre- and post-dedupe detection counts

- **Status:** ✅ **Resolved — no behaviour change.** The finding was withdrawn after
  re-examination against the detection contract below. The rule now explains
  itself in place, which is what was actually missing.
- **Evidence:** [ffmpeg.ts](../../src/services/ffmpeg.ts#L623) computes
  `truncated` from `detected.length` (every `pts_time` match in ffmpeg's stderr)
  while the extracted list is sliced from `unique.length` (deduplicated and
  sorted). The detection pass asks for one frame beyond the budget
  (`detectionLimit = maxFrames + 1`).
- **Impact:** A repeated `pts_time` inflates `detected` relative to `unique`, so a
  list that holds every unique timestamp can still warn that it was truncated.
  That is the conservative direction: the frame behind the ceiling is never
  observed, so it may belong to a distinct scene that the duplicate collapsed.
  Counting unique timestamps instead would report an unverified list as complete —
  the worse error, and the reason the existing duplicate-timestamp test asserts
  `truncated: true`.
- **Recommendation:** None applied beyond the clarifying comment. Do not "fix" the
  count to `unique.length`.

### P3 — Arguments are validated twice per call in both adapters

- **Status:** ✅ **Resolved.** `executeOperation` is the single owner of schema
  validation; both adapters pass the raw payload. The adapter test asserts the
  delegation and that an invalid payload still surfaces as `INVALID_INPUT`.
- **Evidence:** The MCP tool parses
  ([mcpTools.ts](../../src/adapters/mcpTools.ts#L91)), then `executeOperation`
  parses again ([execute.ts](../../src/operations/execute.ts#L70)). The CLI does
  the same ([cli.ts](../../src/adapters/cli.ts#L309)). The MCP SDK has additionally
  already validated the arguments against the same schema before the handler
  runs, which the parity test relies on.
- **Impact:** No defect today, because every current schema is idempotent. The
  trap is future-facing: a schema-level `.transform()` with an observable effect,
  or a validated-and-rewritten value, would run twice. It also means the
  "validation lives in `executeOperation` so embedders cannot bypass it" contract
  is not actually what the adapters do.
- **Recommendation:** Let `executeOperation` own parsing and have the adapters
  pass raw input, or keep the adapter parse and skip it in `executeOperation` via
  an explicit "already parsed" option. Either way, one owner.

### P3 — No CI workflow despite the documented `npm run check` gate

- **Status:** Open (noted in the previous review as well).
- **Evidence:** `.github/workflows/` exists but is empty; the
  [README](../../README.md) documents `npm run check` as the gate and requires
  Node 22 or newer.
- **Impact:** The suite is the project's main safety net — 22 files including
  Windows-specific Skill shim tests — but nothing runs it automatically, so a
  regression (or a Node/ffmpeg-version difference) lands silently. The single
  documented verification path also assumes the reviewer remembers to run it.
- **Recommendation:** Add a workflow running `npm run check` on Node 22 and the
  current LTS, on Linux and Windows, with ffmpeg installed. The integration and
  Skill tests already skip themselves cleanly when a prerequisite is missing, so
  a matrix without ffmpeg still produces signal.

## Strengths

- **Structural interface parity.** The registry is the only list of capabilities
  ([registry.ts](../../src/operations/registry.ts#L17));
  `tests/contract/parity.test.ts` asserts names, schemas, titles, descriptions,
  and read-only/destructive hints, not just that two lists have the same length.
- **Error model.** Every expected failure is a `VideoAnalyzerError` with a stable
  code, an actionable hint, structured details, and a sanitized envelope
  ([errors.ts](../../src/utils/errors.ts)). Cancellation is consistently
  distinguished from timeout and failure at every stage — Gemini, ffmpeg, and
  downloads — which is what makes `OPERATION_CANCELLED` trustworthy.
- **Bounded work.** Frame budgets are enforced _during_ production (`-frames:v`),
  not when the response is assembled; downloads are bounded by declared length
  _and_ by a streaming check; MCP image payloads are bounded by a base64 budget
  with frames kept on disk.
- **Filesystem hygiene.** Each extraction gets a fresh directory, the paging
  manifest is validated against a strict filename pattern (a tampered
  `../../evil.jpg` entry is rejected), and a failed extraction removes its own
  half-populated folder. Transcript writes use `wx` and staged-then-rename, so
  the no-overwrite promise is atomic and a symlink race cannot redirect it.
- **Untrusted `.env` policy.** The allowlist rejects the media binaries, `PATH`,
  the private-host switch, and the launcher path, so a repository cannot choose
  which executable runs or relax the SSRF guard; real environment variables always
  win.
- **Missing key is reported before expensive work.** `assertGeminiAvailable` runs
  before any download or probe, so the caller is not charged gigabytes of
  transfer to learn about a one-line configuration problem.
- **Comments explain decisions, not mechanics** (why the SDK upload path is not
  given `httpOptions`, why uploaded local files are not cached, why the timestamp
  fallback uses `tpad`), which survives refactoring far better than restating the
  code.

## Additional risks and coverage

- **No live Gemini request was made.** Upload transport is tested against the
  real `@google/genai` client through an injected `fetch`, which is the closest
  available proxy, but credential validity, model availability, quotas,
  provider-side retention, and the actual upload response shape were not
  exercised. The strictness in
  [`generateContent`](../../src/services/gemini.ts#L182) — text is only accepted
  when `finishReason === 'STOP'`, with `undefined` treated as incomplete — is
  deliberate and tested, and it will discard a valid response if a future model
  omits the field. Worth revisiting if a provider change ever produces "Gemini did
  not complete its response" alongside a full, sensible transcript.
- **Verification is single-platform.** This review ran on Windows with Node
  26.11.1 and ffmpeg 9.0.2. The Windows-only launcher tests (`cmd.exe` shim,
  payload metacharacters) skip elsewhere, so POSIX coverage of the launcher is
  thinner than the count suggests.
- **Provider errors can reach debug logs verbatim.**
  `logger.debug(String(error))` in
  [gemini.ts](../../src/services/gemini.ts#L595) can include SDK request detail.
  The API key travels in a header rather than the URL, so this is not a key leak,
  but debug output should not be pasted into issues without review.
- **Artifacts accumulate by design.** Every extraction leaves a folder plus
  manifest under `video-analyzer-output/` (gitignored here, documented in the
  README). Running the tool in an unrelated repository will create the same
  directory there; the README already tells users to ignore it.
- **Prompt injection is unbounded by nature.** Media-derived text and the
  caller's `question` reach the model with a system instruction that asks it not
  to invent content, which is a quality control, not a security boundary.
- The legacy `YT_DLP_*` settings are deliberately unread
  ([config.ts](../../src/config.ts#L131)) and documented as no-ops; that is
  consistent with the disabled platform-download feature.

## Verification

| Check                  | Result                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`        | Passed after remediation: typecheck, lint, build, 22 test files, 315 tests passed and 1 skipped, format check clean.                                                                                                                                                                                         |
| Targeted reproductions | Before the fix: timer overflow at `2^31` ms (`runWithBounds` and an end-to-end download), and `.env` dropping `VIDEO_ANALYZER_CLI_PATH`.                                                                                                                                                                     |
| After remediation      | `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS=2147483648` now fails as `INVALID_INPUT` naming `1000 and 2147483647` (exit code 1); the same key at `2147483647` runs normally; `help` still works with a malformed setting; the launcher used the checkout build with `VIDEO_ANALYZER_CLI_PATH` present only in `.env`. |
| Functional spot checks | Metadata, even-mode extraction, paging via `frameSetDir`, tampered-manifest rejection, invalid timestamps, `outputDir`-is-a-file, interval budget warning, missing key ordering, private-host rejection.                                                                                                     |
| Not verified           | Any live Gemini call, non-Windows platforms, other Node versions.                                                                                                                                                                                                                                            |
| Environment            | Windows, Node 26.11.1, ffmpeg/ffprobe 9.0.2, locked `@google/genai` 2.32.0.                                                                                                                                                                                                                                  |

A green suite here establishes that the local media pipeline, adapters, and
configuration behave as documented; it does not establish that a real Gemini
upload succeeds.
