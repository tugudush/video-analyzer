# Video Analyzer

Gemini-powered video and audio analysis you can use **either as an MCP server or as an agent Skill**.

Ask questions about a recording, summarise it, find when something happens, transcribe speech, read technical metadata, and pull frames — from one shared core, exposed through two independent interfaces.

- **MCP interface** — tools discovered by MCP clients.
- **Skill interface** — an on-demand `SKILL.md` workflow that calls the local CLI. **No MCP server required.**

Neither interface depends on the other. Install one, or both.

## What It Does

| Operation          | Purpose                                                   | Needs Gemini |
| ------------------ | --------------------------------------------------------- | ------------ |
| `analyze_video`    | Answer a question about the video and its audio           | yes          |
| `summarize_video`  | Structured summary: overview, key moments, tone, gaps     | yes          |
| `search_timestamp` | Find when an event occurs (estimates, not frame-accurate) | yes          |
| `transcribe_video` | Plain-text speech-to-text                                 | yes          |
| `get_video_info`   | Duration, resolution, frame rate, codecs, size            | no           |
| `extract_frames`   | Frames by count, interval, timestamps, or scene changes   | no           |

Inputs can be local paths, `file://` URIs, direct `http(s)` media URLs, or platform page URLs such as YouTube and Vimeo. A page URL is handed to [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), which the tool runs automatically and which must be installed for those inputs — see [Getting Media from a Platform](#getting-media-from-a-platform).

Deliberately **not** included: text-to-speech, image/video/music generation, multi-provider routing, and licensing or paid tiers.

## Requirements

- Node.js 22 or newer
- FFmpeg (includes `ffprobe`) on `PATH`, or `FFMPEG_PATH` / `FFPROBE_PATH`
- `GEMINI_API_KEY` — only for AI operations ([get a key](https://aistudio.google.com/app/apikey))

`yt-dlp` is required only for platform page URLs (YouTube, Vimeo, …), which the tool downloads for you. Local files and direct media URLs never involve it. Install steps and the `YT_DLP_*` settings are in [Getting Media from a Platform](#getting-media-from-a-platform).

## Install

```bash
git clone <repo-url>
cd video-analyzer
npm install
npm run build
npm install -g .  # optional: puts `video-analyzer` and `video-analyzer-mcp` on PATH
```

Without a global install, use `node /path/to/video-analyzer/dist/cli.js` wherever this document shows `video-analyzer`.

What you actually need depends on how you use the package:

| Setup                                                                            | `npm install` | `npm run build` | Global  |
| -------------------------------------------------------------------------------- | ------------- | --------------- | ------- |
| MCP server                                                                       | yes           | yes             | no      |
| Skill kept in this repo (`skills/video-analyzer`)                                | yes           | yes             | no      |
| Skill copied to a user-level folder (`~/.copilot/skills`, `~/.claude/skills`, …) | yes           | yes             | **yes** |
| Skill copied to a user-level folder, with `VIDEO_ANALYZER_CLI_PATH` set          | yes           | yes             | no      |

`npm run build` is never skippable: `dist/cli.js` and `dist/mcp.js` are compiler output and are not checked in.

## Use as MCP

Add a server entry to your MCP client. VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "videoAnalyzer": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/video-analyzer/dist/mcp.js"],
      "env": {
        "GEMINI_API_KEY": "your-key"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add \
  --env GEMINI_API_KEY=your-key \
  videoAnalyzer -- node /absolute/path/to/video-analyzer/dist/mcp.js
```

Or project-scoped, by committing a `.mcp.json` at the repo root (Claude Code picks it up automatically):

```json
{
  "mcpServers": {
    "videoAnalyzer": {
      "command": "node",
      "args": ["/absolute/path/to/video-analyzer/dist/mcp.js"],
      "env": { "GEMINI_API_KEY": "your-key" }
    }
  }
}
```

Restart the client, then ask for something like _"Summarize ./demo.mp4"_.

> Keep configuration files with API keys out of source control.

## Use as a Skill

The Skill lives in [`skills/video-analyzer`](skills/video-analyzer) and runs the CLI directly — it does **not** talk to the MCP server.

1. Copy the folder into a Skill location. The same folder works in every client below:

   ```bash
   # VS Code / Copilot — project-scoped (committed with the repo)
   mkdir -p .github/skills
   cp -r skills/video-analyzer .github/skills/

   # VS Code / Copilot — personal, across all workspaces
   mkdir -p ~/.copilot/skills
   cp -r skills/video-analyzer ~/.copilot/skills/

   # Claude Code — project-scoped
   mkdir -p .claude/skills
   cp -r skills/video-analyzer .claude/skills/

   # Claude Code — personal
   mkdir -p ~/.claude/skills
   cp -r skills/video-analyzer ~/.claude/skills/

   # Antigravity — personal (App, CLI, and IDE)
   mkdir -p ~/.gemini/config/skills
   cp -r skills/video-analyzer ~/.gemini/config/skills/

   # Agent-agnostic — personal (read by Copilot, Cursor, Codex, and OpenCode; not by Claude Code or Antigravity)
   mkdir -p ~/.agents/skills
   cp -r skills/video-analyzer ~/.agents/skills/
   ```

   `.agents/skills/` (project) is read by Copilot, Cursor, Codex, OpenCode, and Antigravity. `~/.agents/skills/` (personal) is read by Copilot, Cursor, Codex, and OpenCode, but not by Claude Code or Antigravity — Antigravity reads personal Skills only from `~/.gemini/config/skills/`. Copilot and OpenCode also read `~/.claude/skills/`, so that one copy covers Copilot, Claude Code, and OpenCode; Codex never reads it.

   **User-level (global) installs need one extra command.** A Skill copied into `~/.copilot/skills`, `~/.claude/skills`, `~/.agents/skills`, or `~/.gemini/config/skills` no longer sits next to `dist/cli.js`, so the launcher falls back to a `video-analyzer` command on `PATH`. Build the CLI, then expose it:

   ```bash
   # Run inside the repo clone
   npm install
   npm run build
   npm install -g .    # or: npm link
   ```

   The global command points back at the checkout, so keep the clone (at least `dist/` and `node_modules/`) in place — deleting it breaks the global `video-analyzer` binary. To remove it, run `npm uninstall -g video-analyzer` (or `npm unlink -g video-analyzer` after `npm link`).

   If you would rather not install a global command, set `VIDEO_ANALYZER_CLI_PATH` in step 3 instead. That still requires `npm install` and `npm run build`, because `dist/cli.js` loads its dependencies from the checkout's `node_modules/`.

   > A Skill left at `skills/video-analyzer` inside this repo needs neither of the above: the launcher finds the build by relative path.

2. Provide `GEMINI_API_KEY` to the process that runs the agent. The launcher inherits its parent environment, so set it wherever your agent runs commands.

   **Windows** — either the Environment Variables dialog (_Win+R_ → `sysdm.cpl` → Advanced → Environment Variables → **User variables** → New, name `GEMINI_API_KEY`), or PowerShell writing that same user variable:

   ```powershell
   [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'your-key', 'User')
   ```

   **macOS / Linux:**

   ```bash
   echo 'export GEMINI_API_KEY="your-key"' >> ~/.zshrc   # or ~/.bashrc
   ```

   **Any OS — `.env`** in the directory the agent runs from. The CLI reads it at startup, and real environment variables always take precedence:

   ```bash
   cp .env.example .env    # then set GEMINI_API_KEY
   ```

   A `.env` file is treated as untrusted input, because it travels with whatever repository the agent is working in. It may set `GEMINI_API_KEY`, `GEMINI_MODEL`, and the `VIDEO_ANALYZER_*` settings, except the ones listed below; `PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`, `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS`, and `VIDEO_ANALYZER_CLI_PATH` must come from the real environment, so a repository cannot choose the binaries that run, the CLI the Skill launcher spawns, or relax the private-host guard.

   > **After setting a Windows environment variable, restart VS Code.** Windows stores it immediately, but a process only receives an environment snapshot when it starts. Restarting just the terminal is not enough — the integrated terminal inherits VS Code's environment, not the registry.
   >
   > **Developer: Reload Window is not enough either.** That restarts the window and its extension host, but both inherit the environment of the main `Code.exe` process, which is still running with its old snapshot. Quit every VS Code window so the main process exits, then relaunch; or start VS Code from a shell that already has the variable (`code .`); or run `code --restart`. Restarting the local agent host has the same limitation, because it is re-spawned by the same stale parent.
   >
   > Enter the value without surrounding characters: a surrounding quote pair is kept literally in a real environment variable, and a trailing space is trimmed.
   >
   > The `env` block in an MCP config applies **only** to the MCP server. The Skill path never reads it — it inherits the process environment instead. If you use both interfaces, set the key in the OS environment (or `.env`) so both see it.

3. Point the launcher at your build if the CLI is neither in this repo nor on `PATH`:

   ```bash
   export VIDEO_ANALYZER_CLI_PATH=/absolute/path/to/video-analyzer/dist/cli.js
   ```

   On Windows set it as a user variable and restart VS Code, so the agent process inherits it:

   ```powershell
   [Environment]::SetEnvironmentVariable('VIDEO_ANALYZER_CLI_PATH', 'C:\dev\video-analyzer\dist\cli.js', 'User')
   ```

4. Invoke it:
   - **VS Code / Copilot** — run `/video-analyzer`, or just ask about a video; the Skill description covers analysis, summarization, transcription, timestamp search, metadata, and frames.
   - **Claude Code** — ask the same way; the Skill is discovered from `.claude/skills/` or `~/.claude/skills/` and Claude invokes its bundled `scripts/invoke.mjs`.

Check it works:

```bash
# Skill kept in this repo
node skills/video-analyzer/scripts/invoke.mjs list

# User-level Skill (VS Code / Copilot); use ~/.claude/skills/... for Claude Code
node ~/.copilot/skills/video-analyzer/scripts/invoke.mjs list
```

## Use the CLI Directly

```bash
video-analyzer --version
video-analyzer list
video-analyzer help extract_frames
video-analyzer get_video_info --input '{"videoPath":"./demo.mp4"}' --pretty
video-analyzer get_video_info --input-file args.json
cat args.json | video-analyzer get_video_info
```

Piped input is read through EOF, including pauses between chunks. Close the pipe
after writing JSON; use `--input` or `--input-file` when stdin is not being used.

Operations and `list` print one JSON envelope on stdout and write diagnostics to stderr; `--version` and `help` print plain text:

```json
{
  "operation": "get_video_info",
  "ok": true,
  "summary": "Container: mov,mp4,...\nDuration: 00:00:06.000\n...",
  "data": { "durationSeconds": 6, "hasVideo": true, "hasAudio": true },
  "warnings": [],
  "images": [],
  "artifacts": []
}
```

On failure the exit code is non-zero and stdout carries:

```json
{ "ok": false, "error": { "code": "INPUT_NOT_FOUND", "message": "…", "hint": "…" } }
```

### Examples

```bash
# Question about content
video-analyzer analyze_video --input '{"videoPath":"./demo.mp4","question":"What pricing is shown?"}'

# Summary with a focus
video-analyzer summarize_video --input '{"videoPath":"./talk.mp4","focus":"security claims"}'

# When does something happen?
video-analyzer search_timestamp --input '{"videoPath":"./demo.mp4","query":"the error dialog appears"}'

# Transcript to a file
video-analyzer transcribe_video --input '{"videoPath":"./interview.m4a","outputPath":"./interview.txt"}'

# Frames at specific times (a new subfolder of ./frames)
video-analyzer extract_frames --input '{"videoPath":"./demo.mp4","mode":"timestamps","timestamps":[3,12.5,30],"outputDir":"./frames"}'

# Read the next page from the first result's data.outputDir; no new extraction
video-analyzer extract_frames --input '{"frameSetDir":"./frames/frames-...","offset":20,"maxImages":20}'
```

Full argument reference: [`skills/video-analyzer/references/operations.md`](skills/video-analyzer/references/operations.md).

## Getting Media from a Platform

A YouTube, Vimeo, or similar **page** URL is not a media URL: it returns HTML.
When a remote URL answers with a document — or refuses the tool's own request
with an authentication or rate-limit status (401, 403, 407, 429) instead of
returning media — the tool hands the URL to
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and analyzes what it downloads, so the
same call works whether you paste a page or a direct link:

```bash
video-analyzer analyze_video --input \
  '{"videoPath":"https://www.youtube.com/watch?v=JAGPK-UCp60","question":"What is the main argument?"}'
```

For AI operations the tool first asks whether Gemini can fetch the media itself.
A public YouTube URL, and a public direct media URL of at most 15 MB, are passed
to Gemini without any local download or upload. Private, unlisted, or otherwise
unusable YouTube URLs, larger or unknown-size files, and every other remote page
are downloaded first with `yt-dlp` and then uploaded. `get_video_info` and
`extract_frames` need a local file, so they download a page URL regardless.

Local files and direct media URLs never involve yt-dlp. Platform page URLs do, so
`yt-dlp` is required for them: without it the call fails with `DEPENDENCY_MISSING`
and an install hint instead of a vague rejection.

What the tool runs, and what it deliberately does not:

- One video per call — `--no-playlist --playlist-items 1` — even when the URL
  carries a list id.
- Video capped at `YT_DLP_MAX_RESOLUTION` (720p by default), preferring H.264/AAC
  in MP4, with lower-quality fallbacks so a site that only offers VP9/AV1 still
  works. Every fallback keeps that cap; formats that report no height, such as
  audio-only and some adaptive streams, remain eligible.
- Bounded by `VIDEO_ANALYZER_DOWNLOAD_MAX_MB` and by
  `max(VIDEO_ANALYZER_REQUEST_TIMEOUT_MS, 60 s)`. The limit covers the whole
  destination directory, not just one stream, and is enforced while the download
  runs: a transfer that reports no length is stopped within one polling interval
  instead of filling the temporary directory before it is rejected.
- Diagnostics derived from `yt-dlp` output have every URL reduced to its scheme,
  host, and path, so a signed URL's query string never reaches a caller or a log.
- `--ignore-config`, so your own `~/.config/yt-dlp/config` cannot inject options
  (including `--exec`) into a tool that only meant to download a video. Use the
  settings below instead.
- `--proxy` sends yt-dlp through a loopback guard that applies the same per-hop
  validation and address pinning to every request it makes — including the media
  hosts a page points at, which the caller's URL check never sees. A page that
  resolves to, or redirects at, a private or reserved destination fails with
  `DOWNLOAD_FAILED` unless `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true`.

### Install yt-dlp

| Platform                   | Command                             |
| -------------------------- | ----------------------------------- |
| Windows (WinGet)           | `winget install --id yt-dlp.yt-dlp` |
| Windows (Scoop)            | `scoop install yt-dlp`              |
| macOS (Homebrew)           | `brew install yt-dlp`               |
| Debian 12+ / Ubuntu 22.04+ | `sudo apt install yt-dlp`           |
| pipx (any OS)              | `pipx install yt-dlp`               |
| pip (any OS)               | `python -m pip install -U yt-dlp`   |

Prebuilt binaries for every platform are on the
[releases page](https://github.com/yt-dlp/yt-dlp/releases). Confirm with
`yt-dlp --version`, and keep it current — a stale extractor is the most common
cause of a site that worked last month failing today (`yt-dlp -U` for a standalone
binary, or your package manager's upgrade command).

If `yt-dlp` is installed somewhere off `PATH`, set `YT_DLP_PATH` to the executable.

### Settings

| Variable                | Default            | Purpose                                                                  |
| ----------------------- | ------------------ | ------------------------------------------------------------------------ |
| `YT_DLP_PATH`           | `yt-dlp` from PATH | Executable the tool spawns.                                              |
| `YT_DLP_MAX_RESOLUTION` | `720`              | Highest video height to download; 144–4320.                              |
| `YT_DLP_COOKIES_FILE`   | —                  | Netscape cookies file for age-restricted, private, or member-only media. |
| `YT_DLP_IMPERSONATE`    | —                  | Client passed to `--impersonate`, such as `chrome` or `chrome-136`.      |

All four are environment-only. A repository's `.env` cannot set them, because they
name an executable, a credential file, or a network identity.

Windows environment variables work directly. Either the Environment Variables
dialog (_Win+R_ → `sysdm.cpl` → Advanced → Environment Variables → **User
variables** → New), or PowerShell writing that same user variable:

```powershell
[Environment]::SetEnvironmentVariable('YT_DLP_COOKIES_FILE', 'C:\Users\you\.config\video-analyzer\cookies.txt', 'User')
[Environment]::SetEnvironmentVariable('YT_DLP_IMPERSONATE', 'chrome', 'User')
```

Use `'Machine'` instead of `'User'` for the whole system; that needs an elevated
shell. A `User` variable is enough for the tool and does not require admin rights.

Two things to know:

- **Restart VS Code afterwards — all windows.** Windows stores the variable
  immediately, but a process receives its environment snapshot only at startup,
  and the integrated terminal inherits VS Code's snapshot rather than reading the
  registry. _Developer: Reload Window_ is not enough: it restarts the window and
  extension host, which inherit the still-running main process's snapshot. Quit
  every window and relaunch, start VS Code from a shell that already has the
  variable, or run `code --restart`. The `env` block of an MCP config applies to
  the MCP server only; the Skill path inherits the process environment, so an OS
  variable serves both.
- **Real environment variables win over `.env`.** If `.env` ever holds a
  `VIDEO_ANALYZER_*` value you want to override, the OS variable is the one used.
  For `YT_DLP_*` there is nothing to override: `.env` cannot set them at all.

### When a platform download fails

| Symptom                                            | Fix                                                          |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `yt-dlp is required ... but was not found on PATH` | Install yt-dlp, or set `YT_DLP_PATH`.                        |
| `HTTP Error 403` / a bot check                     | `YT_DLP_IMPERSONATE=chrome`, then `YT_DLP_COOKIES_FILE`.     |
| `The platform requires a signed-in session`        | `YT_DLP_COOKIES_FILE` with cookies from a signed-in browser. |
| `No stream matches the requested format`           | Raise `YT_DLP_MAX_RESOLUTION`.                               |
| `yt-dlp cannot impersonate that browser`           | Install `yt-dlp[default]`, or unset `YT_DLP_IMPERSONATE`.    |

The tool already asks YouTube for a second player client when the default one is
refused, which resolves most 403s without configuration.

#### Supplying cookies

Cookies are needed for age-restricted, private, and member-only media, and
sometimes for ordinary videos when the site demands a signed-in session. Export
them to a Netscape-format file and point `YT_DLP_COOKIES_FILE` at it:

1. Sign in to the site in your browser.
2. Export the site's cookies with a `cookies.txt` exporter — "Get cookies.txt
   LOCALLY" for Chrome, Edge, or Firefox — for the domain (`youtube.com` for
   YouTube).
3. Save the file outside your repositories, for example
   `~/.config/video-analyzer/cookies.txt`, and export
   `YT_DLP_COOKIES_FILE` with its path.

The format is one tab-separated record per cookie — domain, include-subdomains,
path, secure, expiry in Unix seconds, name, value — under a
`# Netscape HTTP Cookie File` header. HTTP-only cookies are prefixed `#HttpOnly_`,
so keep the `#`-prefixed lines:

```text
# Netscape HTTP Cookie File
.youtube.com	TRUE	/	TRUE	1789000000	SID	sample-value
```

Reading the browser profile directly (`yt-dlp --cookies-from-browser`) is not
exposed as a setting because it usually fails on Windows: Chrome 127 and later
encrypt cookies with App-Bound Encryption, which yt-dlp cannot decrypt, and Edge
and Brave inherit the same scheme. Exporting a file works everywhere.

A malformed file fails loudly with `ERROR: 'cookies.txt' does not look like a
Netscape format cookies file`. Cookies are live credentials for the account that
exported them: keep the file out of version control, restrict its permissions, and
delete it when you are done. yt-dlp rewrites the file with refreshed cookies at
exit.

## Configuration

| Variable                             | Default              | Purpose                                                                                                                    |
| ------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`                     | —                    | Required for AI operations                                                                                                 |
| `GEMINI_MODEL`                       | `gemini-3.8-flash`   | Model for all AI calls                                                                                                     |
| `VIDEO_ANALYZER_MAX_FRAMES`          | `100`                | Frame budget for `extract_frames` (scene capped at 200); `0` keeps only the 500-frame hard cap                             |
| `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`     | `2048`               | Remote download size limit                                                                                                 |
| `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`  | `300000`             | Deadline for each Gemini call: upload request, status poll, or generation; the remaining upload budget can shorten it      |
| `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`   | `600000`             | Budget for uploading the media and waiting for `ACTIVE`; the clock starts before the upload                                |
| `VIDEO_ANALYZER_POLL_INTERVAL_MS`    | `2000`               | Upload status poll interval                                                                                                |
| `VIDEO_ANALYZER_OUTPUT_DIR`          | cwd                  | Base directory for generated artifacts                                                                                     |
| `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` | `false`              | Allow private/loopback media hosts, including for platform downloads                                                       |
| `VIDEO_ANALYZER_CACHE_DIR`           | —                    | Opt-in directory for the persistent Gemini upload-reference cache; environment only                                        |
| `VIDEO_ANALYZER_LOG_LEVEL`           | `warn`               | `silent`/`error`/`warn`/`info`/`debug`                                                                                     |
| `VIDEO_ANALYZER_CLI_PATH`            | auto                 | CLI path used by the Skill launcher. Environment only: the launcher reads the process environment and never a `.env` file. |
| `FFMPEG_PATH` / `FFPROBE_PATH`       | `ffmpeg` / `ffprobe` | Binaries                                                                                                                   |

The `YT_DLP_*` settings drive platform downloads and are documented with their defaults in [Getting Media from a Platform](#getting-media-from-a-platform). They are read from the environment only.

The three millisecond settings are capped at `2147483647` (2^31 - 1), the largest delay Node's timers accept; a larger value is rejected as `INVALID_INPUT` rather than silently firing the deadline after one millisecond.

A `.env` file in the working directory may only set `GEMINI_API_KEY`, `GEMINI_MODEL`, and the `VIDEO_ANALYZER_*` settings above. `FFMPEG_PATH`, `FFPROBE_PATH`, `PATH`, `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS`, `VIDEO_ANALYZER_CACHE_DIR`, `VIDEO_ANALYZER_CLI_PATH`, and the `YT_DLP_*` settings are deliberately rejected there: the file travels with a repository, and a repository must not be able to choose the binaries or credentials that run, turn off the private-host guard, or redirect retained metadata into a directory it controls.

When `loadConfig()` is called without an explicit environment object — as the CLI and MCP entry points do — a `.env` file is applied into `process.env` (real variables win), so the parsed settings and the process environment stay in sync. Embedders that read configuration without touching global process state should pass their own environment object, as the tests do.

Details: [`skills/video-analyzer/references/configuration.md`](skills/video-analyzer/references/configuration.md).

## Errors

Every failure uses a stable code: `INVALID_INPUT`, `CONFIG_MISSING`, `DEPENDENCY_MISSING`, `INPUT_NOT_FOUND`, `UNSUPPORTED_INPUT`, `URL_REJECTED`, `DOWNLOAD_FAILED`, `MEDIA_PROCESSING_FAILED`, `GEMINI_UPLOAD_FAILED`, `GEMINI_PROCESSING_FAILED`, `GEMINI_REQUEST_FAILED`, `GEMINI_TIMEOUT`, `OUTPUT_FAILED`, `OPERATION_CANCELLED`, `INTERNAL`.

`OPERATION_CANCELLED` means the caller gave up — Ctrl-C, MCP tool cancellation, or an embedding caller's signal. Every cancelable stage (Gemini calls, FFmpeg runs, downloads) reports it the same way instead of as a media, network, or disk failure.

Recovery guidance: [`skills/video-analyzer/references/troubleshooting.md`](skills/video-analyzer/references/troubleshooting.md).

## Known Limitations

- **Single provider.** If Gemini is down or out of quota, AI operations fail with a clear error. There is no fallback provider by design.
- **Timestamps are estimates.** `search_timestamp` reflects Gemini's internal sampling. Confirm with `extract_frames` before cutting.
- **Interval frame labels are approximate.** They describe the sampling grid, not the exact presentation times of the source frames.
- **Requested frame times are not source timestamps.** Timestamp extraction selects the first frame at or after the requested time, or the last frame if the seek reaches the end. Labels and `data.timestamps` retain the requested times; the end-of-clip fallback can be slower.
- **Multi-stream inputs use the first real video stream.** Metadata and all frame extraction modes use the first video stream reported by ffprobe that is not embedded cover art, even if a different stream is marked default. Audio files whose artwork is stored as an `attached_pic` stream are reported as audio-only and rejected by `extract_frames`.
- **Transcription is plain text.** No speaker diarization and no per-cue timings; `.srt`/`.vtt` targets are rejected rather than fabricated.
- **Sensitive media leaves the machine** for AI operations.
- **Gemini retains uploads.** The [Gemini Files API](https://aistudio.google.com/docs/file-input-methods) documents 48-hour storage for uploaded files. This tool does not delete them remotely; use the [Files API](https://aistudio.google.com/api-reference/files) to list or delete them sooner. Deleting a reused upload makes the next request upload it again.
- **Local AI inputs are snapshotted and content-cached.** Each AI call copies the file into an owned temporary snapshot and hashes it, so changed bytes are never mistaken for an unchanged file. Unchanged content reuses a valid upload within the process, and across processes when `VIDEO_ANALYZER_CACHE_DIR` is set. That cache stores only a Gemini file name, MIME type, and expiry — no media, prompts, or credentials — and the caller's file is never modified or deleted.
- **Direct Gemini inputs have no local metadata.** For a YouTube URL or a small direct URL, `data.durationSeconds` is `null` and a warning says metadata-based checks were skipped. If Gemini rejects the URL and the tool downloads it instead, `data.source` reports `download` and the downloaded file is probed, so duration becomes available again. Container details require media the tool downloads or reads locally.
- **MCP inlines extracted frames.** `extract_frames` embeds JPEGs up to a 2 MiB base64 budget per call; frames that do not fit, including the first, are reported by path instead. Each inlined image is preceded by its path and label. The CLI returns paths only. Frames are capped at a 1280-pixel longest edge without upscaling.
- **SSRF protection is defense in depth.** Each HTTP request — the media probe,
  downloads, and redirects — is resolved and validated separately, and connections
  use the validated addresses while preserving the original hostname for TLS.
  Private hosts are blocked unless explicitly opted in; do not treat media parsing
  or this filter as a complete sandbox.
- **Platform downloads use an external downloader.** Page URLs are fetched by
  `yt-dlp` through a loopback guard that applies the same destination policy, so a
  page cannot redirect the downloader at a private address unless
  `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true`. Playlists are truncated to the first
  item, `yt-dlp` config files are ignored, and the download is capped by
  `YT_DLP_MAX_RESOLUTION` and `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`. URLs with embedded
  credentials remain blocked.
- **Temporary cleanup is best-effort.** If removal fails, a warning names the directory so it can be deleted manually. Warnings follow `VIDEO_ANALYZER_LOG_LEVEL`; `silent` suppresses them. Startup cleanup only removes old, marked directories whose owning process has exited. Older unmarked temporary files are left untouched and may need manual removal.
- **Frame extraction writes to disk.** Each extraction persists frames and a paging manifest until you delete its `data.outputDir`. Later pages use `frameSetDir` and do not download or extract again. By default output goes into `video-analyzer-output/` under the working directory (or `VIDEO_ANALYZER_OUTPUT_DIR`), which this repository ignores in `.gitignore`; add the same entry to any repository you run the tool in.

## Architecture

```text
MCP client ──> MCP adapter ─┐
                            ├──> operation registry ──> services ──> Gemini / FFmpeg / yt-dlp
Agent Skill ──> CLI adapter ─┘
```

The registry (`src/operations/registry.ts`) is the single source of truth for names, schemas, and handlers. Capability parity between the two interfaces is structural, and enforced by `tests/contract/parity.test.ts`.

See [`findings-and-plan.md`](findings-and-plan.md) for the original design rationale.

## Development

```bash
npm run typecheck    # tsc --strict, includes tests
npm run lint         # oxlint (src, tests, skills)
npm run lint:fix     # oxlint --fix
npm test             # build, then vitest (unit, contract, integration, skill)
npm run format       # prettier
npm run check        # typecheck + lint + tests + format check
```

`npm test` and `npm run check` run `npm run build` first (`pretest`). The Skill suite drives the packaged launcher in `dist/`, so without that build a clean checkout would fail for a reason unrelated to the change.

Integration tests generate their own media fixtures with ffmpeg and skip when ffmpeg or ffprobe is unavailable. Check the test runner's skip count before relying on a green run.

An opt-in live smoke test (`tests/integration/liveGemini.test.ts`) uploads a generated two-second clip to Gemini and checks the answer. It runs only when `VIDEO_ANALYZER_LIVE_TEST=1` and a Gemini API key are set for the test process and ffmpeg is installed, so the default suite stays offline and free:

```bash
# bash
VIDEO_ANALYZER_LIVE_TEST=1 npm test
```

```powershell
# PowerShell
$env:VIDEO_ANALYZER_LIVE_TEST='1'; npm test
```

### Why oxlint instead of ESLint

`typescript-eslint@8` refuses to load on TypeScript 7 (`does not support TS 7.0`) and declares `typescript: ">=4.8.4 <6.1.0"`, so ESLint cannot parse this repo's TypeScript. oxlint parses TypeScript itself with no dependency on the compiler API and runs as a single binary.

The trade-off is real: **oxlint has no type-aware rules**, so things like `no-floating-promises` and `no-misused-promises` are not checked. `tsc --strict` covers nullability and exhaustiveness but not unawaited promises. Expect to migrate to ESLint + `typescript-eslint` once TS 7 support lands; `.oxlintrc.json` maps over almost one-to-one.

`no-console` is an error on purpose: stdout must stay machine-readable for the CLI envelope and the MCP stdio transport, so diagnostics go to stderr.

## Licence

MIT
