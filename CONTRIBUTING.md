# Contributing to AcpGram

Thank you for helping! Bug reports, ideas and pull requests are welcome.

## Reporting bugs and asking for features

- Open an issue: <https://github.com/selesnow/acpgram/issues>.
- For a bug, include the AcpGram version (`acpgram version`), your OS, the Node.js version, the engine you use
  (Gemini CLI, Claude Code, Antigravity CLI or Codex) and the steps to reproduce. Remove tokens, API keys and personal
  data from logs and screenshots.
- **Security problems are not reported in public issues.** Follow [SECURITY.md](SECURITY.md) (private reporting).

## Contribution process

1. For a larger change, open an issue first so we can agree on the idea before you spend time on it.
2. Fork the repository and create a branch from `main`.
3. Make the change and add tests (see below).
4. Run `npm test` — it must pass. Pull requests are also checked automatically on Linux, Windows and macOS (CI), by
   CodeQL code scanning and by dependency review.
5. Open a pull request against `main` and describe what changes and why. Keep one topic per pull request.

The maintainer reviews pull requests and may ask for changes. By contributing you agree that your contribution is
released under the [MIT license](LICENSE) of the project.

## Requirements for acceptable contributions

- **Tests.** The project has an automated test suite (`npm test`, Node's built-in `node:test`, files in `test/`).
  A new feature or a bug fix must come with tests that fail without the change; a pull request that adds major
  functionality without tests is not accepted.
- **No runtime dependencies.** AcpGram is plain Node.js (>= 22.13, ES modules, `.mjs`) with no runtime npm dependencies; please
  do not add any. A development-only dependency needs a clear reason (today only ESLint).
- **Lint.** `npm run lint` (ESLint) must pass with no warnings; CI runs it on every pull request. Fix the code instead of
  silencing a rule; where a rule is disabled on purpose, say why in the comment next to it.
- **Code style.** Follow the style of the surrounding code: ES modules, 2-space indent, single quotes, semicolons,
  small functions with a short comment that explains the reason, not the obvious.
- **Texts for users.** Every string the bot shows goes through `src/i18n.mjs` and must exist in all three languages
  (`en`, `ru`, `uk`); the test suite checks that the dictionaries match. Terminal messages of the `acpgram` command are
  in `src/cli-i18n.mjs`.
- **Documentation.** If behaviour, a command or a setting changes, update the README (`README.md` is English;
  `README.ru.md` is the Russian translation) and the settings table.
- **Security.** Never commit secrets (`.env`, tokens, keys). Treat everything that comes from Telegram or from files a user
  sends as untrusted input. GitHub secret scanning with push protection is enabled on the repository.
- **Cross-platform.** The code must work on Windows, Linux and macOS (use `node:path`, no shell-specific commands).
- **Commits.** A short, clear message that says what changed; one logical change per commit.

## Development setup

```sh
git clone https://github.com/selesnow/acpgram.git
cd acpgram
npm test            # tests need no install step: there are no runtime dependencies
npm ci && npm run lint   # ESLint (development-only)
cp .env.example .env # fill in TELEGRAM_BOT_TOKEN and ALLOWED_USER_ID to run the bot
npm start
```
