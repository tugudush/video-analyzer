# Troubleshooting

Each failure returns a JSON envelope with `error.code`. Use the code to decide
what to do next.

## CONFIG_MISSING

`GEMINI_API_KEY is not set.`

Set the key in the environment. If the user cannot, or does not want to, use a
cloud API, switch to a local operation:

- `get_video_info`
- `extract_frames`

## DEPENDENCY_MISSING

`ffmpeg is required but was not found on PATH.` — no binary matched, so FFmpeg is
not installed or not on `PATH`.

`The configured media binary was not found: <path>` — `FFMPEG_PATH` or
`FFPROBE_PATH` points at something that does not exist. Fix the setting; note
that those two settings are read from the environment only, never from `.env`.

Install FFmpeg, then either put it on `PATH` or point at it:

```bash
export FFMPEG_PATH=/usr/bin/ffmpeg
export FFPROBE_PATH=/usr/bin/ffprobe
```

## INPUT_NOT_FOUND

The path does not exist from the current working directory. Confirm with the user
whether they meant a relative or absolute path, or whether the file is on another
machine.

## UNSUPPORTED_INPUT

Cause and fix:

| Message                              | Fix                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Unknown media type                   | Use a common container (`mp4`, `mov`, `webm`, `mkv`, `mp3`, `m4a`, `wav`)    |
| Empty file                           | Re-export or re-download the media                                           |
| Frame extraction on audio-only input | Use `transcribe_video` instead                                               |
| Downloaded content type unknown      | Use a URL path ending in a media extension or a local file                   |
| URL did not return media             | Use a direct media URL or a local file; platform page downloads are disabled |

## URL_REJECTED

The host resolves to a private, loopback, link-local, or metadata address, or
the URL contains embedded credentials. This is a defense-in-depth SSRF guard,
not a sandbox for untrusted media.

If the media genuinely lives on the user's own network:

```bash
export VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true
```

Only do this deliberately. Never enable it because a remote URL "seemed fine".
The opt-in does not allow embedded credentials or enable yt-dlp.

## DOWNLOAD_FAILED

- HTTP status errors: the link is expired, requires authentication, or is region-blocked.
- Size errors: raise `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`.
- Timeouts (`The download did not finish within N ms`) — the download budget is
  `max(VIDEO_ANALYZER_REQUEST_TIMEOUT_MS, 60 s)`. Raise
  `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS` for large files or slow links.

## GEMINI_UPLOAD_FAILED

Usually a file-size, format, or quota constraint on the API tier. Ask the user to
try a shorter clip or an MP4/H.264/AAC re-export.

## GEMINI_TIMEOUT

The message tells which bound ran out:

- `Gemini did not respond within N ms (stage)` — one call (upload, status poll, or
  generation) exceeded its deadline. The hint names the setting that applied:
  `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS` caps every call, but an upload or a status
  poll is also bounded by what is left of `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`, and
  the shorter of the two wins. Retry, raise the setting the hint names, or use a
  shorter clip.
- `Gemini did not finish processing the media in time` — the upload plus the wait
  for `ACTIVE` exceeded `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`. Large uploads can take
  minutes, so raise it or trim the clip.

## GEMINI_PROCESSING_FAILED

Gemini could not decode the media. Most often an unusual container or codec.
Re-encode:

```bash
ffmpeg -i input.mkv -c:v libx264 -pix_fmt yuv420p -c:a aac output.mp4
```

## GEMINI_REQUEST_FAILED

Check the key, the model ID in `GEMINI_MODEL`, quota, and network access. An empty
response usually means the prompt was blocked by safety filters. If Gemini
stopped before completing its answer, retry with a shorter input or request;
partial text is not returned or written as a transcript.

## INVALID_INPUT

The JSON did not match the schema (including an `intervalSec` below the 0.1
second floor), or `transcribe_video` rejected its output target. Run:

```bash
node ./scripts/invoke.mjs help <operation>
```

to print the JSON Schema. Common causes: passing numbers as strings or using
`timestamps` without `mode: "timestamps"`.

`transcribe_video` refusals, all reported before any upload or generation:

| Message                                            | Fix                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Refusing to overwrite an existing file             | Pass `"overwrite": true`, or choose another `outputPath`         |
| outputPath must not refer to the source media file | Point `outputPath` at a new file, for example `./transcript.txt` |
| outputPath is a directory, not a file              | Pass a file path, not a folder                                   |
| Subtitle output (.srt) is not supported            | Write a plain `.txt` transcript instead                          |

## MEDIA_PROCESSING_FAILED

ffmpeg/ffprobe ran but failed. The `hint` contains the tail of the ffmpeg error —
usually a corrupt file, a stream-copy container mismatch, or a missing decoder.
Re-encode, or try a different source file.

`ffmpeg did not finish within N ms` means the command hit its internal time
budget rather than failing on the media: use a shorter clip, a smaller `count`,
or a larger `intervalSec`. A cancelled run is reported as
`OPERATION_CANCELLED` instead, never as this code.

`extract_frames` in `timestamps` mode reports this only after checking every
requested value against the media duration, so an out-of-range timestamp comes
back as `INVALID_INPUT` naming the value and the clip length instead.

## OUTPUT_FAILED

Writing something the caller asked for failed. Two cases:

- `Could not create the artifact directory` — `extract_frames` could not create its
  output folder. `details.outputDir` (or `details.outputRoot`) names the base that
  failed and `details.code` the OS error; a common cause is passing a file where a
  directory is expected, or a read-only volume. Choose a writable directory.
- A transcript that could not be written is **not** an error: the operation still
  returns the text in `summary` and adds a warning naming the target and the OS
  error, with `data.outputWritten: false`. Re-run with a writable `outputPath`
  only if the file is needed; re-transcribing is required in that case.

## OPERATION_CANCELLED

The caller stopped the run: Ctrl-C on the CLI, MCP tool cancellation, or an
embedding caller's signal. Nothing is wrong with the media, the network, or the
disk — the operation was aborted mid-flight (during an upload, a generation, an
FFmpeg run, or a download). Re-run if the result is still needed.

## Nothing happens / no output

The Skill launcher needs either a global `video-analyzer` binary or a local
`dist/cli.js`. Either install the package or point at a build:

```bash
export VIDEO_ANALYZER_CLI_PATH=/path/to/video-analyzer/dist/cli.js
```

## Results look wrong

- **Timestamps are off:** `search_timestamp` is model-estimated. Confirm with
  `extract_frames` at nearby times before trusting a cut. Interval-frame labels
  are approximate sampling-grid times, not exact source-frame timestamps.
- **Transcript is rough:** Gemini transcription is plain text with no diarization.
  Use a dedicated speech-to-text service if that is required.
- **Fewer frames than expected:** In `interval` mode `data.truncated: true` means
  fewer frames were produced than the duration-based estimate. If the warning
  names the frame budget (`VIDEO_ANALYZER_MAX_FRAMES`, hard ceiling 500), raise
  the budget, increase `intervalSec`, or use `mode: "even"` to spread a fixed
  count across the clip. Otherwise, check the media's timing and duration. In
  `scene` mode truncation means the list hit
  the 200-frame scene ceiling (or the configured budget when smaller): raise
  `sceneThreshold` so fewer changes match.
