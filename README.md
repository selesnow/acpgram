# AcpGram

**English** · [Русский](README.ru.md)

A Telegram gateway to AI coding agents — **Gemini CLI**, **Claude Code** and **Antigravity CLI**. The bot runs the agent as a subprocess on the machine where it is installed and talks to it over the [Agent Client Protocol](https://agentclientprotocol.com) (JSON-RPC over stdin/stdout). You write a task in Telegram; the agent works in the selected project on your server, PC or laptop, and you watch its progress, approve its actions and get the answer right in the chat.

- No npm dependencies — plain Node.js 24 (built-in `node:sqlite`, `fetch`).
- Windows, Linux and macOS. Tested on Windows Server and Linux (Ubuntu in WSL); macOS uses the same code as Linux.
- Multi-user: the main admin invites teammates and controls what each of them can do.

> The bot's interface is currently in Russian.

## Features

- **Streaming replies** in a Telegram draft with a stop button: the agent's thoughts, the steps it takes (reading files, running commands, searching, editing) and the elapsed time, then the answer itself.
- **Rich final answer** — headings, lists, tables, code blocks — with a collapsible "work log" of every step and a footer showing the engine, the actual model, reasoning level, tokens, cost (Claude Code) and time.
- **Three engines, one interface** — `/engine` switches between Gemini CLI, Claude Code and Antigravity CLI; the default engine is set in `.env`.
- **Model and reasoning level** — `/model` lists the models the agent itself reports (plus `effort` for Claude Code and `thought_level` for Antigravity); the choice is remembered per user and per engine.
- **Permission requests as buttons** — "Allow", "Allow for this session", "Reject". Options that would persist a rule forever or raise the session above the user's access level are never shown.
- **Projects** — `/project` picks the working folder by buttons, by name search or by path (`/project ~/projects/web`), with one-tap recent projects.
- **Sessions** — `/sessions` resumes a previous conversation (in the engine it was created in), even after a restart; `/new` starts fresh; `/close` unloads the agent process.
- **Team access** — invite links and access requests; per-user access levels, engines and model restrictions; `/active` shows who is working and lets the admin end any session.
- **Audit log** — SQLite database with sessions, requests, tool calls, permissions, answers, token usage and cost.

## Supported engines

| Engine | How it is started | Install | Auth |
|---|---|---|---|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini --acp` | `npm i -g @google/gemini-cli` | `GEMINI_API_KEY` or Gemini CLI login |
| [Claude Code](https://www.anthropic.com/claude-code) | `claude-agent-acp` ([ACP bridge](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)) | `npm i -g @agentclientprotocol/claude-agent-acp` | `ANTHROPIC_API_KEY` or Claude Code login |
| [Antigravity CLI](https://antigravity.google/docs/cli/acp/) 1.5+ | `agy acp` | see Antigravity docs | Google sign-in once: `agy acp --login` |

Only the default engine (`DEFAULT_ENGINE`, Gemini CLI unless set) is required; the others are optional — engines that are not installed are simply not offered.

## Quick start

Requirements: **Node.js 24+**, at least one engine from the table above, and a Telegram bot token from [@BotFather](https://t.me/BotFather) (Bot API 10.1+ — rich messages and drafts).

```bash
git clone https://github.com/selesnow/acpgram.git
cd acpgram
npm start          # the first start without .env opens the setup wizard
```

The **setup wizard** (`npm run setup`, safe to re-run — current values are suggested):

1. bot token — checked right away with `getMe`;
2. main admin — just send any message to your bot, the wizard picks up your Telegram ID;
3. projects root — optional (see `PROJECTS_ROOT` below);
4. engines — finds installed Gemini CLI, Claude Code and Antigravity CLI, stores their full paths (so they are found under a service too), asks for the default engine;
5. API keys — optional; the token, keys and passwords are typed hidden;
6. writes `.env` (owner-only permissions; the previous one goes to `data/.env.bak`), creates the database and sends you a test message;
7. offers to install the bot as a service.

### Run as a service

Autostart with the system and restart on failure — one command:

| OS | How | Command |
|---|---|---|
| Windows | Windows service via [nssm](https://nssm.cc) (`winget install --id NSSM.NSSM -e`); run the terminal as administrator; you will be offered to run the service under your account (where the agents are signed in) | `npm run service:install` |
| Linux | `systemd --user` (to keep it running without a login session: `sudo loginctl enable-linger $USER`) | `npm run service:install` |
| macOS | LaunchAgent (`launchd`) | `npm run service:install` |

Also: `npm run service:status`, `npm run service:uninstall`. Options go after `--` (otherwise npm takes them for itself): `npm run service:install -- --dry-run` prints the commands without running them, `-- --name <name>` sets another service name (default `acpgram`; Windows and Linux), `-- --system` installs a Windows service under LocalSystem without a terminal. Logs: `data/service.log` (Linux: `journalctl --user -u acpgram -f`).

> On Windows the account password is passed to `nssm` as a command-line argument — this is how nssm grants the "Log on as a service" right. It is never printed or stored by the bot and is visible in the process list only to administrators and the same user for the fraction of a second the command runs. Without a terminal the service can only be installed with `--system` (LocalSystem).

### Docker

```bash
cp .env.example .env     # set TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID, GEMINI_API_KEY and uncomment PROJECTS_DIR
docker compose up -d --build
```

In the container the agent sees only the mounted projects folder (`PROJECTS_DIR` → `/projects`). The image ships Gemini CLI only (Claude Code and Antigravity CLI are not included yet), so keep `DEFAULT_ENGINE` at `gemini`.

## Bot commands

| Command | Who | What |
|---|---|---|
| `/start` | everyone | welcome screen: engine, model, access level, project |
| `/project [name or path]` | everyone | choose the working folder |
| `/engine [gemini, claude, agy]` | everyone | choose the engine |
| `/model` | everyone | choose the model and reasoning level |
| `/new` | everyone | new session |
| `/sessions` | everyone | resume a previous session in this project |
| `/stop` | everyone | stop the running request |
| `/close`, `/exit` | everyone | close the session and unload the agent process |
| `/users` | admin | teammates: level, engines, models, end session, revoke access |
| `/active` | admin | active sessions with buttons to end them |
| `/invite` | admin | one-time invite link (24 h) |

## Access levels

The main admin is set by `ALLOWED_USER_ID`. Everyone else gets access through an invite link or by asking (the request goes to the admin with buttons).

| Level | Gemini CLI | Claude Code | Antigravity CLI | Meaning |
|---|---|---|---|---|
| Read | `plan` | `plan` | `plan` | the agent only reads and analyzes |
| Normal | `default` | `default` | `default` | permission requests go to the user |
| Full | `autoEdit` | `bypassPermissions` | `accept-edits` | edits without confirmation (Claude Code: no confirmations at all) |
| Admin | `autoEdit` | `bypassPermissions` | `accept-edits` | change with `ACP_MODE`/`GEMINI_ADMIN_MODE`, `CLAUDE_ADMIN_MODE`, `AGY_ADMIN_MODE` |

New teammates get only the default engine; the admin grants other engines and can restrict models per user and per engine. At most `MAX_AGENTS` (3) teammate agents run at once across all engines (the admin is not counted); idle sessions close after `IDLE_MINUTES` (30).

> An agent mode limits what the agent does, but it is **not a sandbox**: the agent runs with the rights of the account the bot runs under. The project folder is where it starts, not a jail. All users share the API keys and quotas. Give the "Full" level (Claude Code `bypassPermissions`) deliberately.

## Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | bot token |
| `ALLOWED_USER_ID` | yes | Telegram ID of the main admin |
| `PROJECTS_ROOT` | no | projects root: projects can be chosen only inside it (team server). Without it any folder on the machine can be chosen, the home folder by default (personal install) |
| `DEFAULT_ENGINE` | no | `gemini` (default), `claude` or `agy`; the bot does not start if this engine is not installed |
| `GEMINI_API_KEY` | no | Gemini API key, passed to the agent through the bot's environment |
| `ANTHROPIC_API_KEY` | no | Anthropic API key for Claude Code (API billing instead of a subscription) |
| `GEMINI_COMMAND`, `CLAUDE_COMMAND`, `AGY_COMMAND` | no | full paths to the engines if they are not in `PATH` (typical for services) |
| `ACP_MODE` / `GEMINI_ADMIN_MODE`, `CLAUDE_ADMIN_MODE`, `AGY_ADMIN_MODE` | no | admin session mode per engine |
| `MAX_AGENTS` | no | concurrent teammate agents (3) |
| `IDLE_MINUTES` | no | idle session timeout, minutes (30) |
| `ANIMATED_ICONS` | no | `0` — plain emoji instead of animated icons in drafts |

`.env` is never committed. Keep the token and keys out of the code.

## Development

```bash
npm test     # node:test, no dependencies, no Telegram
```

```
src/
  main.mjs        entry point: loads .env, runs the setup wizard on first start
  setup.mjs       setup wizard
  service.mjs     service: nssm (Windows), systemd --user (Linux), launchd (macOS)
  bot.mjs         message and button routing, access checks
  engines.mjs     engine registry: commands, modes per level, catalogs, usage parsing
  acp.mjs         Agent Client Protocol client (agent subprocess)
  access.mjs      per-user engines and models, model catalogs, applying the choice
  turn.mjs        one request: streaming draft, work log, permissions, final answer
  state.mjs       per-user state: agent process, engine, project, limits, idle reaper
  admin.mjs       invites, access requests, /users, /active
  projects.mjs    project paths (inside the root or anywhere), recent projects, search
  *Ui.mjs         /project, /sessions, /engine, /model screens
  ui.mjs          rendering: drafts, steps, final message, screens
  telegram.mjs    Bot API calls, rich messages, long text splitting
  db.mjs          SQLite: sessions, requests, tool calls, permissions, users, usage
test/             node:test tests and a fake ACP agent
```

## License

[MIT](LICENSE) © 2026 Alexey Seleznev
