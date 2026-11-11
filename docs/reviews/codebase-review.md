# Codebase review

## Remediation status — 2026-11-12

- The four P2 findings and the P3 documentation issue were fixed and covered by
  regression tests. Timestamp results now require the standalone `NO_MATCH`
  marker; explanations after it are deliberately treated as unknown, rather
  than risking another false negative.
- Download connections are pinned to each hop's validated DNS addresses while
  preserving the URL hostname for HTTP and TLS.
- The provider's documented upload retention and manual early-deletion policy
  are now described in the README and Skill configuration reference. Automatic
  deletion is not enabled because it would invalidate uploads shared by
  concurrent requests; provider retention remains a privacy consideration.
- The CI matrix recommendation is deferred. A live Gemini request was not
  performed as part of this remediation.
- `npm run check` passed on Windows with Node 22.23.4, 24.12.0, and 26.11.1
  (299 tests passed and one platform-dependent test skipped on each). A local
  HTTPS check also confirmed hostname/SNI preservation and certificate hostname
  rejection with pinned DNS.

The findings and verification below describe the original review, before
remediation; their source line references may have shifted.

Reviewed 2026-11-11 against commit `14b3b77` and the working tree. This is a
correctness, reliability, and maintainability review, not a penetration test.
No application code was changed.

## Summary

The project has a clear shared-core design: CLI and MCP adapters expose the same
operation registry, and services isolate Gemini, FFmpeg, and media resolution.
Schema validation, bounded frame extraction, explicit error codes, temporary
directory ownership, and substantial unit and integration coverage are
strengths.

Four reproducible issues merit attention: uncertain timestamp answers can become
false negatives, the Skill drops successful CLI diagnostics, DNS resolution
is outside download cancellation and deadlines, and embedded MCP servers share a
global logging sink. A minor documentation count is also stale.

Severity: **P2** means a meaningful defect under the stated conditions; **P3**
means a lower-impact defect.

## Findings

### P2 — An uncertain timestamp answer can become a definite negative

- **Evidence:** [`isNoMatch`](../../src/operations/searchTimestamp.ts#L79)
  accepts `NO_MATCH` anywhere in a response with no parsed matches, and the
  [result branch](../../src/operations/searchTimestamp.ts#L116) returns
  `found: false`. Other unparseable answers correctly return `found: null`.
- **Reproduced:** With a generated audio fixture and an injected Gemini service,
  the response `I cannot determine whether this occurs; do not conclude
NO_MATCH.` produced `No match found` and `found: false`.
- **Impact:** A model explanation or refusal that mentions the marker can be
  presented as evidence that the event did not occur, misleading downstream
  clients and agents.
- **Recommendation:** Treat only an unambiguous negative response as
  `NO_MATCH`; preserve uncertain or malformed responses as `found: null`. Add
  cases for quoted/negated markers and retain the intentionally supported
  `NO_MATCH — explanation` form where appropriate.

### P2 — The Skill hides diagnostics from successful CLI runs

- **Evidence:** The launcher
  [captures stderr](../../skills/video-analyzer/scripts/invoke.mjs#L75) but
  [forwards it only on a nonzero exit](../../skills/video-analyzer/scripts/invoke.mjs#L193).
  Temporary cleanup failures are reported through
  [`logger.warn`](../../src/utils/fsUtils.ts#L35), not the result envelope.
- **Reproduced:** A successful CLI stub that wrote a JSON result to stdout and
  `Warning: cleanup failed` to stderr yielded an empty launcher stderr.
- **Impact:** Skill users can miss a failed cleanup and be unaware that
  downloaded media remains on disk. Verbose progress and other successful-run
  diagnostics are also lost. Operation warnings included in the JSON envelope
  remain visible.
- **Recommendation:** Forward successful child stderr as well, without mixing it
  into JSON stdout; test successful warnings and cleanup-failure diagnostics.

### P2 — DNS resolution is not bounded by the download deadline or cancellation

- **Evidence:** [`downloadToFile`](../../src/utils/net.ts#L251) creates a timeout
  signal, but awaits [`assertSafeHttpUrl`](../../src/utils/net.ts#L254) before
  passing the signal to `fetch`. Its
  [`lookup`](../../src/utils/net.ts#L205) has no cancellation or deadline;
  [redirect validation](../../src/utils/net.ts#L320) has the same gap.
- **Reproduced:** A controlled 300 ms DNS lookup, a 50 ms download timeout, and
  cancellation after 10 ms returned `OPERATION_CANCELLED` only after about
  329 ms. An already-cancelled request for a blocked loopback address returned
  `URL_REJECTED` instead of cancellation.
- **Impact:** Slow or stalled name resolution can delay cancellation and exceed
  the advertised download budget; its error can also mask cancellation.
- **Recommendation:** Apply the remaining deadline and caller cancellation to
  every resolution/validation stage, classify their failures consistently, and
  add delayed-DNS and pre-cancelled regression tests. Continue validating every
  redirect.

### P2 — Embedded MCP servers do not isolate logging

- **Evidence:** Each [`createMcpServer`](../../src/adapters/mcpServer.ts#L36)
  installs a process-global [`setLogSink`](../../src/utils/logger.ts#L33);
  [closing any server](../../src/adapters/mcpServer.ts#L96) clears that global
  sink. The server factory is part of the public embedding surface.
- **Reproduced:** After creating servers A and B in one process, a logger
  message associated with A was delivered to B's logging callback.
- **Impact:** Multiple embedded servers, or an embedded server alongside other
  users of the logger, can route diagnostics to the wrong client or lose MCP
  logging when another server closes. Paths and operational details in
  diagnostics can cross those boundaries.
- **Recommendation:** Bind sinks to individual logger/server instances rather
  than global state. Test two concurrent servers and closing either one.

### P3 — FFmpeg skip count in development documentation is stale

- **Evidence:** The [README](../../README.md#L330) says 11 integration tests
  are skipped without FFmpeg. The current run contains
  [24 local-media tests](../../tests/integration/localMedia.test.ts#L22) plus
  [one MCP test](../../tests/integration/mcpServer.test.ts#L97) guarded by the
  shared FFmpeg/ffprobe availability check.
- **Impact:** Developers may underestimate how much integration coverage was
  skipped on a machine without both binaries.
- **Recommendation:** Update the count or avoid a fixed count and instruct
  readers to inspect the test runner's skipped-test summary.

## Additional risks and coverage gaps

- The README already correctly describes the
  [DNS-rebinding window](../../src/utils/net.ts#L11): URL validation and the
  eventual connection resolve separately. Treat the guard as defense in depth,
  not a boundary against a determined attacker; consider connecting to a
  validated address while preserving the original host and TLS verification.
- Gemini upload cleanup removes local temporary media, but the
  [Gemini API abstraction](../../src/services/gemini.ts#L36) has no remote
  deletion operation; local files are uploaded on every request. Remote media
  retention is therefore governed by the provider's file lifecycle, not local
  cleanup. Document the retention policy and consider an explicit deletion
  policy compatible with upload reuse.
- Tests use injected or mocked Gemini APIs; this review did not make a live
  provider request or validate the configured model, credentials, quotas, or
  provider-side retention.
- No tracked CI workflow was found in the repository. The checks below were run
  on Windows with Node 26.11.1 and FFmpeg 9.0.2, not across the entire supported
  Node 22+ range or all operating systems. A CI matrix with FFmpeg installed
  would make those checks repeatable.

## Verification

| Check                  | Result                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `npm test`             | Passed: 19 files, 287 tests passed, 1 skipped; FFmpeg integration tests ran.                        |
| `npm run typecheck`    | Passed.                                                                                             |
| `npm run lint`         | Passed.                                                                                             |
| `npm run format:check` | Passed before this report was written.                                                              |
| Targeted reproductions | Confirmed the four P2 behaviors described above using local fixtures, stubs, and injected services. |

The single skipped test was platform/environment conditional. A passing suite
does not establish that the live Gemini integration works or that every
supported runtime has been exercised.
