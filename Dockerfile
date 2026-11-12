# Telegram-шлюз к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI, Codex) в контейнере.
# Агент видит только смонтированную папку проектов (/projects) — в отличие от установки напрямую,
# где он работает с правами учётной записи во всей системе.
FROM node:24-slim

# Какие движки ставить в образ (через пробел): gemini claude codex agy.
# Облегчить образ: docker compose build --build-arg ENGINES="gemini claude"
ARG ENGINES="gemini claude codex agy"

# Версии фиксируются, чтобы обновление было осознанным:
#   docker compose build --build-arg GEMINI_CLI_VERSION=... (и так же для остальных)
# Antigravity CLI ставится официальным скриптом и всегда берёт последнюю версию (закрепить её нечем).
ARG GEMINI_CLI_VERSION=0.67.0
ARG CLAUDE_ACP_VERSION=latest
ARG CODEX_CLI_VERSION=latest
ARG CODEX_ACP_VERSION=latest

# tini — init-процесс: передаёт сигналы боту и забирает завершённые процессы агентов (без «зомби»).
# git и ripgrep нужны агенту для работы с кодом; curl — для установщика Antigravity CLI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ripgrep ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'

# Движки на npm: Gemini CLI, мосты ACP для Claude Code и Codex (и сам Codex CLI, который мост запускает).
RUN set -eu; pkgs=""; \
    for e in $ENGINES; do \
      case "$e" in \
        gemini) pkgs="$pkgs @google/gemini-cli@${GEMINI_CLI_VERSION}" ;; \
        claude) pkgs="$pkgs @agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" ;; \
        codex)  pkgs="$pkgs @openai/codex@${CODEX_CLI_VERSION} @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" ;; \
        agy)    ;; \
        *) echo "Неизвестный движок в ENGINES: $e (допустимо: gemini claude codex agy)" >&2; exit 1 ;; \
      esac; \
    done; \
    if [ -n "$pkgs" ]; then npm install -g $pkgs; fi; \
    npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# data/ (база бота) и домашние папки движков (настройки, вход, история сессий) — тома, чтобы переживать пересоздание контейнера.
# Antigravity CLI хранит вход в ~/.gemini, как и Gemini CLI.
RUN mkdir -p /app/data /projects /home/node/.gemini /home/node/.claude /home/node/.codex /home/node/.local/bin \
 && chown -R node:node /app/data /projects /home/node

USER node
ENV PATH="/home/node/.local/bin:${PATH}"

# Antigravity CLI (agy): официальный установщик кладёт бинарник в ~/.local/bin. Нужна версия 1.5+ с подкомандой acp.
# Сборка падает, если установка не удалась или подкоманды acp нет, — без этого движок молча не работал бы.
RUN case " $ENGINES " in *" agy "*) \
      curl -fsSL https://antigravity.google/cli/install.sh | bash \
      && agy --version \
      && agy acp --help >/dev/null ;; \
    esac

ENV PROJECTS_ROOT=/projects \
    GEMINI_COMMAND=gemini \
    CLAUDE_COMMAND=claude-agent-acp \
    CODEX_COMMAND=codex-acp \
    AGY_COMMAND=agy

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/bot.mjs"]
