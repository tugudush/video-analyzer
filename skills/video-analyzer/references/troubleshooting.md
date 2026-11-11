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

`ffmpeg is required but was not found on PATH.`

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
the URL contains embedded credentials. This blocks SSRF attempts.

If the media genuinely lives on the user's own network:

```bash
export VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true
```

Only do this deliberately. Never enable it because a remote URL "seemed fine".
The opt-in does not allow embedded credentials or enable yt-dlp.

## DOWNLOAD_FAILED

- HTTP status errors: the link is expired, requires authentication, or is region-blocked.
- Size errors: raise `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`.

## GEMINI_UPLOAD_FAILED

Usually a file-size, format, or quota constraint on the API tier. Ask the user to
try a shorter clip or an MP4/H.264/AAC re-export.

## GEMINI_TIMEOUT

The message tells which budget ran out:

- `Gemini did not respond within N ms (stage)` — one call (upload, status poll, or
  generation) exceeded `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`. Retry, raise it, or use
  a shorter clip.
- `Gemini did not finish processing the media in time` — the upload plus the wait
  for `ACTIVE` exceeded `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`. Large uploads can take
  minutes, so raise it or trim the clip.
- `The Gemini request was cancelled` — the caller gave up (MCP tool cancellation
  or Ctrl-C) and the in-flight request was aborted. Nothing is wrong with the
  media; retry if the result is still needed.

## GEMINI_PROCESSING_FAILED

Gemini could not decode the media. Most often an unusual container or codec.
Re-encode:

```bash
ffmpeg -i input.mkv -c:v libx264 -pix_fmt yuv420p -c:a aac output.mp4
```

## GEMINI_REQUEST_FAILED

Check the key, the model ID in `GEMINI_MODEL`, quota, and network access. An empty
response usually means the prompt was blocked by safety filters.

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

## Nothing happens / no output

The Skill launcher needs either a global `video-analyzer` binary or a local
`dist/cli.js`. Either install the package or point at a build:

```bash
export VIDEO_ANALYZER_CLI_PATH=/path/to/video-analyzer/dist/cli.js
```

## Results look wrong

- **Timestamps are off:** `search_timestamp` is model-estimated. Confirm with
  `extract_frames` at nearby times before trusting a cut.
- **Transcript is rough:** Gemini transcription is plain text with no diarization.
  Use a dedicated speech-to-text service if that is required.
- **Fewer frames than expected:** `data.truncated: true` means a ceiling cut the
  list. In `interval` mode that is the frame budget (`VIDEO_ANALYZER_MAX_FRAMES`,
  hard ceiling 500): raise the budget, increase `intervalSec`, or use
  `mode: "even"` to spread a fixed count across the clip. In `scene` mode it is
  the 200-frame scene ceiling (or the configured budget when smaller): raise
  `sceneThreshold` so fewer changes match.
