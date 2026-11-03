# Configuration

Set these in the environment where the CLI runs. The Skill inherits the ambient
environment, so exporting them in the shell (or in the MCP client config, for the
MCP interface) is enough.

## How the key reaches the CLI

```text
agent shell  ──> node scripts/invoke.mjs  ──spawn──> video-analyzer CLI  ──> process.env
```

`invoke.mjs` spawns the CLI without an `env` override, so the CLI sees exactly the
environment your agent had. Three ways to supply `GEMINI_API_KEY`, in precedence
order:

1. **Real environment variable** — highest priority.

   Windows: set a **user** variable, either in _System Properties → Environment Variables → User variables → New_, or from PowerShell:

   ```powershell
   [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'your-key', 'User')
   ```

   Restart VS Code afterwards. Windows writes the registry entry immediately, but a process only
   receives an environment snapshot at startup, and the integrated terminal inherits VS Code's
   environment rather than the registry — so restarting the terminal alone changes nothing.
   Type the value without surrounding quotes and without a trailing space; both yield an invalid key.

   macOS / Linux:

   ```bash
   echo 'export GEMINI_API_KEY="your-key"' >> ~/.zshrc   # or ~/.bashrc
   ```

   Or launch the agent from a shell that already exported it.

2. **`.env` in the working directory** — read once at startup. Only fills
   variables that are unset or blank, so it can never override a real export.
   Lines may use `export KEY=value`, quotes, and `#` comments. Malformed lines are
   skipped silently, and escape sequences are not interpreted.

   ```bash
   cp .env.example .env    # then set GEMINI_API_KEY
   ```

3. **MCP config `env` block** — applies to the MCP server only. The Skill path
   never reads it, because the Skill runs the CLI directly.

Verify without revealing the value:

```bash
node ./scripts/invoke.mjs list    # works regardless of the key
```

Then run any AI operation; `CONFIG_MISSING` in the response means the key is not
reaching the CLI.

## Required for AI operations

| Variable         | Purpose                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GEMINI_API_KEY` | Gemini API key. Required by `analyze_video`, `summarize_video`, `search_timestamp`, `transcribe_video`, and `redact_sensitive` when `detectionMode` is `ai`. |

Get a key from <https://aistudio.google.com/app/apikey>.

Local operations (`get_video_info`, `extract_frames`, manual `redact_sensitive`)
work without it.

## Model

| Variable       | Default            | Purpose                                                       |
| -------------- | ------------------ | ------------------------------------------------------------- |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model ID for all AI calls. Must handle video and audio input. |

If the configured model is unavailable for your account, the API error is surfaced
verbatim. No silent model substitution happens.

## Limits

| Variable                            | Default  | Purpose                                                                                                                               |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `VIDEO_ANALYZER_MAX_FRAMES`         | `100`    | Frame ceiling for AI-assisted sampling and scene detection budgets. `0` removes the frame ceiling; basic resource guards still apply. |
| `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`    | `2048`   | Maximum size of a remote download.                                                                                                    |
| `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS` | `300000` | Gemini request timeout.                                                                                                               |
| `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`  | `600000` | How long to wait for uploads to become `ACTIVE`.                                                                                      |
| `VIDEO_ANALYZER_POLL_INTERVAL_MS`   | `2000`   | Upload status poll interval.                                                                                                          |

## Output

| Variable                    | Default           | Purpose                                                                                              |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `VIDEO_ANALYZER_OUTPUT_DIR` | current directory | Base directory for `video-analyzer-output/` folders that hold frames, previews, and redacted videos. |

## Binaries

| Variable                | Default   | Purpose                                                   |
| ----------------------- | --------- | --------------------------------------------------------- |
| `FFMPEG_PATH`           | `ffmpeg`  | ffmpeg executable.                                        |
| `FFPROBE_PATH`          | `ffprobe` | ffprobe executable.                                       |
| `YT_DLP_PATH`           | `yt-dlp`  | yt-dlp executable.                                        |
| `YT_DLP_MAX_RESOLUTION` | unset     | Preferred maximum height for platform downloads.          |
| `YT_DLP_COOKIES_FILE`   | unset     | Cookies file for private or authenticated sources.        |
| `YT_DLP_IMPERSONATE`    | unset     | Browser to impersonate when a site blocks plain requests. |

## Network

| Variable                             | Default | Purpose                                                                                         |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` | `false` | Allow loopback, private, link-local, and metadata addresses. Only enable for media you control. |

## Diagnostics

| Variable                   | Default       | Purpose                                                                                  |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `VIDEO_ANALYZER_LOG_LEVEL` | `warn`        | `silent`, `error`, `warn`, `info`, or `debug`. `info`/`debug` stream progress to stderr. |
| `VIDEO_ANALYZER_CLI_PATH`  | auto-detected | Explicit path to `dist/cli.js` for the Skill launcher.                                   |

## Example

```bash
export GEMINI_API_KEY="…"
export VIDEO_ANALYZER_OUTPUT_DIR="$HOME/video-output"
export YT_DLP_MAX_RESOLUTION=1080
node ./scripts/invoke.mjs list
```
