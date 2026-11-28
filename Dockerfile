# Telegram-шлюз к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI, Codex, OpenCode, Qwen Code) в контейнере.
# Агент видит только смонтированную папку проектов (/projects) — в отличие от установки напрямую,
# где он работает с правами учётной записи во всей системе.
# Базовый образ закреплён по digest (воспроизводимая сборка); новый digest предлагает Dependabot.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# Какие движки ставить в образ (через пробел): gemini claude codex agy opencode qwen.
# Облегчить образ: docker compose build --build-arg ENGINES="gemini claude"
ARG ENGINES="gemini claude codex agy opencode qwen"

# Версии фиксируются, чтобы обновление было осознанным:
#   docker compose build --build-arg GEMINI_CLI_VERSION=... (и так же для остальных)
# Antigravity CLI ставится официальным скриптом и всегда берёт последнюю версию (закрепить её нечем).
ARG GEMINI_CLI_VERSION=0.67.0
ARG CLAUDE_ACP_VERSION=0.113.0
ARG CODEX_CLI_VERSION=0.172.0
ARG CODEX_ACP_VERSION=2.12.1
ARG OPENCODE_VERSION=1.19.6
ARG QWEN_VERSION=0.29.0

# tini — init-процесс: передаёт сигналы боту и забирает завершённые процессы агентов (без «зомби»).
# git и ripgrep нужны агенту для работы с кодом; curl — для установщика Antigravity CLI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ripgrep ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'

# Движки на npm: Gemini CLI, мосты ACP для Claude Code и Codex (и сам Codex CLI, который мост запускает), OpenCode, Qwen Code.
RUN set -eu; pkgs=""; \
    for e in $ENGINES; do \
      case "$e" in \
        gemini) pkgs="$pkgs @google/gemini-cli@${GEMINI_CLI_VERSION}" ;; \
        claude) pkgs="$pkgs @agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" ;; \
        codex)  pkgs="$pkgs @openai/codex@${CODEX_CLI_VERSION} @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" ;; \
        opencode) pkgs="$pkgs opencode-ai@${OPENCODE_VERSION}" ;; \
        qwen)   pkgs="$pkgs @qwen-code/qwen-code@${QWEN_VERSION}" ;; \
        agy)    ;; \
        *) echo "Неизвестный движок в ENGINES: $e (допустимо: gemini claude codex agy opencode qwen)" >&2; exit 1 ;; \
      esac; \
    done; \
    if [ -n "$pkgs" ]; then npm install -g $pkgs; fi; \
    npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# data/ (база бота) и домашние папки движков (настройки, вход, история сессий) — тома, чтобы переживать пересоздание контейнера.
# Antigravity CLI хранит вход в ~/.gemini, как и Gemini CLI; OpenCode — вход и сессии в ~/.local/share/opencode.
RUN mkdir -p /app/data /projects /home/node/.gemini /home/node/.claude /home/node/.codex /home/node/.local/bin /home/node/.local/share/opencode \
 && chown -R node:node /app/data /projects /home/node

USER node
ENV PATH="/home/node/.local/bin:${PATH}"

# Antigravity CLI (agy): официальный установщик кладёт бинарник в ~/.local/bin. Нужна версия 1.5+ с подкомандой acp.
# Сборка падает, если установка не удалась или подкоманды acp нет, — без этого движок молча не работал бы.
ARG AGY_INSTALLER_URL=https://antigravity.google/cli/install.sh
ARG AGY_INSTALLER_SHA256=62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042
RUN case " $ENGINES " in *" agy "*) \
      curl -fsSL "$AGY_INSTALLER_URL" -o /tmp/agy-install.sh \
      && echo "$AGY_INSTALLER_SHA256  /tmp/agy-install.sh" | sha256sum --check - \
      && bash /tmp/agy-install.sh \
      && rm -f /tmp/agy-install.sh \
      && agy --version \
      && agy acp --help >/dev/null ;; \
    esac

ENV PROJECTS_ROOT=/projects \
    GEMINI_COMMAND=gemini \
    CLAUDE_COMMAND=claude-agent-acp \
    CODEX_COMMAND=codex-acp \
    AGY_COMMAND=agy \
    OPENCODE_COMMAND=opencode \
    QWEN_COMMAND=qwen

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/bot.mjs"]
