# Codebase review

Reviewed 2026-11-11 against commit `eedc752` on Windows. Scope: the shared
operations, CLI and MCP adapters, Skill launcher, media and Gemini services,
filesystem and network helpers, documentation, and relevant tests. This is a
risk-focused review, not a security certification.

## Resolution

The four findings below have been addressed. The original findings and evidence
are retained for context.

## Original findings

### P2 - Skill launcher can corrupt non-ASCII output

[`invoke.mjs`](../../skills/video-analyzer/scripts/invoke.mjs) previously
concatenated each stdout and stderr `Buffer` into a string independently. A
UTF-8 character split across pipe chunks was decoded as replacement characters.
This could silently corrupt transcripts, answers, and error messages.

**Evidence:** A simulated CLI wrote `Café` with the two bytes of `é` in separate
chunks; the launcher returned `Caf��`. No Gemini call was involved.

**Recommendation:** Decode the streams incrementally with `setEncoding('utf8')`
or a `StringDecoder`, or concatenate buffers before decoding. Add a launcher test
that splits a multibyte character across writes.

**Resolution:** Both streams use incremental UTF-8 decoding. A launcher regression
test splits a character across writes to both stdout and stderr.

### P2 - Unparseable timestamp responses report a positive match

When Gemini did not follow the expected format,
[`searchTimestamp.ts`](../../src/operations/searchTimestamp.ts) returned an
empty `matches` array but set `found: true`, even when the response said no
event was found. Consumers using `found` could treat an unknown or negative
result as a confirmed match.

**Evidence:** With a generated one-second clip and a simulated provider response
of `I could not find a red car in the video.`, the operation returned
`found: true`, `matches: []`, and that text as the summary.

**Recommendation:** Represent an unparseable response as unknown or return an
explicit error rather than asserting a match. Keep the raw response and add tests
for unstructured negative and ambiguous replies.

**Resolution:** Unparseable responses now use `found: null`, preserve the raw
answer and warning, and are covered by negative and ambiguous response tests.

### P2 - Cancelling a Gemini poll leaves its timer alive

The default polling sleep in [`gemini.ts`](../../src/services/gemini.ts) used a
normal timer. Cancellation rejected the wait but did not clear the timer. A
short-lived CLI process could remain running until the poll interval or remaining
upload budget expired, despite already reporting cancellation.

**Evidence:** With a simulated upload in `PROCESSING` and a two-second poll
interval, cancellation was reported after 64 ms, but the Node process exited
after approximately 2.3 seconds. Longer configured intervals extend the delay.

**Recommendation:** Use a cancellable sleep that clears its timer when the
signal aborts. Test both prompt rejection and process/timer cleanup during a
poll, including shared-upload cancellation.

**Resolution:** Poll delays clear their timers on cancellation. Tests cover local
uploads, the last shared-upload waiter, and a shared upload with another waiter.

### P2 - Scene detection scans and buffers past the frame budget

[`extractSceneFrames`](../../src/services/ffmpeg.ts) previously ran detection
over the whole video and buffered FFmpeg's `showinfo` stderr before applying the
configured limit. A long or frequently changing video could fail or consume
substantial resources even when only a small number of frames was requested.

**Evidence:** Code inspection: the first pass has no output-frame limit; the
budget is applied only after the subprocess completes. This failure threshold
was not reproduced with a large real video.

**Recommendation:** Bound detection as well as extraction, for example by
stopping after the budget plus one detected scene so `truncated` remains
accurate. Add a test proving detection stops early when enough scenes exist.

**Resolution:** Detection is limited to the budget plus one scene. Unit tests
check the FFmpeg limits and truncation, and a real FFmpeg fixture checks both an
exact fit and a truncated result. Inputs with fewer scene changes still require
scanning to the end of the video. A simulated older FFmpeg verifies the legacy
frame-sync fallback; that fallback was not tested with an older binary.

## Validation and coverage

- After the fixes, `npm run check` passed: typecheck, lint, build, tests, and
  formatting. Vitest reported **287 passed, 1 skipped**; FFmpeg integration
  tests ran.
- The skipped test is the Windows symlink case requiring suitable privileges.
- The Unicode and cancellation reproductions used local simulated processes or
  provider responses. The timestamp reproduction used a generated local video
  and simulated provider response. No live Gemini calls were made.
- After cancellation with a five-second poll interval, a simulated upload
  reported `OPERATION_CANCELLED` in 52 ms and the process exited in 323 ms.
- The previous review's cleanup, Gemini finish-reason, stream-selection, and
  numeric timestamp-description fixes are present; the suite covers those
  regressions.

## Strengths and remaining limitations

- A shared registry and execution path support CLI/MCP parity, with contract and
  integration coverage. Downloads enforce byte limits and validate redirects.
- As documented in the [README](../../README.md), DNS validation is not pinned
  to the connection; the network guard is defense in depth, not a complete SSRF
  boundary. Model-generated timestamps are estimates and need verification.
- Mocked provider tests do not establish live Gemini compatibility or output
  quality. Generated frame artifacts persist on disk until manually removed.
