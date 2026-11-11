# Telegram-шлюз к Gemini CLI в контейнере.
# Агент видит только смонтированную папку проектов (/projects) — в отличие от установки напрямую,
# где он работает с правами учётной записи во всей системе.
FROM node:24-slim

# Версия Gemini CLI фиксируется, чтобы обновление было осознанным: docker compose build --build-arg GEMINI_CLI_VERSION=...
ARG GEMINI_CLI_VERSION=0.67.0

# tini — init-процесс: передаёт сигналы боту и забирает завершённые процессы агентов (без «зомби»).
# git и ripgrep нужны агенту для работы с кодом.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' \
 && npm install -g @google/gemini-cli@${GEMINI_CLI_VERSION} \
 && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# data/ (база бота) и ~/.gemini (настройки и история сессий Gemini) — тома, чтобы переживать пересоздание контейнера
RUN mkdir -p /app/data /projects /home/node/.gemini && chown -R node:node /app/data /projects /home/node/.gemini

ENV PROJECTS_ROOT=/projects \
    GEMINI_COMMAND=gemini
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/bot.mjs"]
