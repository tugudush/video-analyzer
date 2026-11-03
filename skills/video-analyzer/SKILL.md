---
name: video-analyzer
description: 'Analyze video and audio files with Gemini and local FFmpeg: answer questions about content, summarize, find when something happens, transcribe speech, read metadata, extract frames, and redact sensitive screen regions. Use when the user asks about a video file, screen recording, podcast, or audio clip — including "what happens in this video", "summarize this recording", "when does X occur", "transcribe this audio", "what resolution is this", "grab a frame at 30s", or "blur the API key in this recording". Works on local paths, file:// URIs, direct http(s) URLs, and platform URLs supported by yt-dlp. Runs through a local CLI; no MCP server or API-specific setup is required beyond GEMINI_API_KEY for AI operations.'
argument-hint: 'A video path or URL plus what you want to know about it'
---

# Video Analyzer

Answer questions about video and audio files by running the bundled `video-analyzer` CLI. The CLI calls Gemini for AI work and FFmpeg/yt-dlp for local media work.

**This skill does not need an MCP server.** It invokes the CLI directly.

## When to Use

Use this skill when the user:

- mentions a video, screen recording, webinar, podcast, interview, or audio clip and wants to know something about it
- asks to summarize, transcribe, or search a recording
- wants a frame, thumbnail, or screenshot from a video
- needs technical media details (duration, resolution, codec, frame rate)
- wants to hide secrets visible in a screen recording

Do **not** use it for:

- generating video, audio, images, or music (unsupported by design)
- editing or re-encoding beyond redaction
- unrelated programming questions

## Before You Start

1. Confirm the user gave a usable input: a path, `file://` URI, direct `http(s)` URL, or platform URL.
2. AI operations need `GEMINI_API_KEY`. Local operations (`get_video_info`, `extract_frames`, manual `redact_sensitive`) work without it.
3. `ffmpeg`/`ffprobe` must be installed. `yt-dlp` is only needed for platform URLs.

If a prerequisite is missing, report exactly what is missing and how to fix it. Do not install packages or add API keys on the user's behalf.

## Choosing the Operation

| The user wants                                                | Operation          | Needs Gemini |
| ------------------------------------------------------------- | ------------------ | ------------ |
| An answer to a specific question about content                | `analyze_video`    | yes          |
| A general overview of the whole video                         | `summarize_video`  | yes          |
| The moment something happens ("when does…", "at what point…") | `search_timestamp` | yes          |
| Speech converted to text                                      | `transcribe_video` | yes          |
| Duration, resolution, codec, frame rate, size                 | `get_video_info`   | no           |
| Still images at times, intervals, or scene changes            | `extract_frames`   | no           |
| Hiding secrets/passwords/keys on screen                       | `redact_sensitive` | optional     |

Rules of thumb:

- If the request is a question with a specific subject, prefer `analyze_video`.
- If the request is "tell me about this video", prefer `summarize_video`.
- If the user asks _where/when_, prefer `search_timestamp` — never claim frame accuracy.
- If the user wants to inspect visuals themselves, prefer `extract_frames`.
- Run `get_video_info` first when you need duration or dimensions to choose frames or regions.

## Procedure

1. **Identify the input and the intent.** Pick one operation from the table above.
2. **Run the launcher** with a JSON payload. Use a single-quoted JSON string on bash, or `--json-file` on Windows shells:

   ```bash
   node ./scripts/invoke.mjs get_video_info '{"videoPath":"./demo.mp4"}'
   ```

   ```powershell
   node .\scripts\invoke.mjs get_video_info --json-file .\args.json --pretty
   ```

3. **Read the JSON envelope on stdout.** It always contains `ok`, and on success `summary`, `warnings`, `images`, `artifacts`. On failure it contains `error.code`, `error.message`, and usually `error.hint`.
4. **Relay the result, not the envelope.** Summarize `summary` in your own words; include `warnings` when they affect trust (especially timestamp accuracy).
5. **Report artifact paths** so the user can open the files (`artifacts[].path`, `images[].path`).

See [operations.md](./references/operations.md) for the full argument list, examples, and output shape for every operation.

## Example Prompts and Calls

**Ask a question**

```bash
node ./scripts/invoke.mjs analyze_video '{"videoPath":"./demo.mp4","question":"What pricing is shown on screen?"}'
```

**Summarize**

```bash
node ./scripts/invoke.mjs summarize_video '{"videoPath":"https://example.com/talk.mp4","focus":"security claims"}'
```

**Find a moment**

```bash
node ./scripts/invoke.mjs search_timestamp '{"videoPath":"./demo.mp4","query":"the presenter opens the settings menu"}'
```

**Transcribe**

```bash
node ./scripts/invoke.mjs transcribe_video '{"videoPath":"./interview.m4a","language":"Spanish","translateToEnglish":true,"outputPath":"./interview.txt"}'
```

**Grab frames**

```bash
node ./scripts/invoke.mjs extract_frames '{"videoPath":"./demo.mp4","mode":"timestamps","timestamps":[3,12.5,30],"outputDir":"./frames"}'
```

**Redact a known area**

```bash
node ./scripts/invoke.mjs redact_sensitive '{"videoPath":"./recording.mp4","effect":"blur","regions":[{"x":40,"y":320,"width":420,"height":32,"label":"API key"}],"previewOnly":true}'
```

## Presenting Results

- Quote the model's answer faithfully. If `warnings` says timestamps are estimates, say so.
- When the operation returns no match or no speech, state that plainly instead of inventing content.
- When frames or videos are written, give the exact absolute paths from `images[]` / `artifacts[]`.
- Do not paraphrase `data` into false precision (for example, do not round a `search_timestamp` estimate into "exactly at 4m12s").

## Handling Failures

| `error.code`                                  | Meaning                                       | What to tell the user                                                           |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `CONFIG_MISSING`                              | No `GEMINI_API_KEY`                           | Set the key, or use a local-only operation                                      |
| `DEPENDENCY_MISSING`                          | `ffmpeg`/`ffprobe`/`yt-dlp` not found         | Install the tool or set `FFMPEG_PATH` / `YT_DLP_PATH`                           |
| `INPUT_NOT_FOUND`                             | Path does not exist                           | Ask for the correct path                                                        |
| `URL_REJECTED`                                | Private/reserved host blocked                 | Set `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true` only if the user trusts that host |
| `CONSENT_REQUIRED`                            | AI redaction needs consent                    | Ask before uploading frames to Google                                           |
| `GEMINI_TIMEOUT` / `GEMINI_PROCESSING_FAILED` | Long or unsupported media                     | Try a shorter clip or convert to MP4/H.264                                      |
| `UNSUPPORTED_INPUT`                           | Not a media file, or audio-only frame request | Pick a different operation                                                      |

See [troubleshooting.md](./references/troubleshooting.md) for recovery steps.

## Boundaries

- Never claim to have watched a video without running an operation.
- Never fabricate timestamps, speakers, or on-screen text.
- Never enable AI redaction or upload personal media without asking first.
- Never overwrite the user's source file: let the CLI choose an output path, or pass a new one.
- Prefer `previewOnly: true` before rendering a redacted video the user has not reviewed.
