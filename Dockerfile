# JARVIS — server (headless) rejimi: Telegram bot, avtonom missiyalar, agentlar, dashboard.
# Mikrofon / ekran / iPhone / doim eshitish faqat Mac'da ishlaydi (Docker'da yo'q).
FROM node:22-bookworm-slim

ARG OPENCLAW_VERSION=2026.7.1-2
ARG INSTALL_BROWSER=true

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl ca-certificates git ffmpeg procps tini build-essential libffi-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN npm install -g "openclaw@${OPENCLAW_VERSION}" && npm cache clean --force

WORKDIR /app

# 1) Python muhitlari (requirements/*.txt aniq versiyalar; macOS'ga xos pyobjc tashlab ketiladi).
#    Kod o'zgarganda bu qatlam qayta qurilmaydi.
COPY requirements/ requirements/
RUN uv python install 3.11 3.12 \
 && for spec in workers:3.12 babyagi:3.12 autogpt:3.11 interpreter:3.11; do \
      name="${spec%%:*}"; py="${spec##*:}"; \
      uv venv --python "$py" ".venv-$name" \
      && grep -viE '^pyobjc' "requirements/$name.txt" > "/tmp/req-$name.txt" \
      && uv pip install --python ".venv-$name/bin/python" -r "/tmp/req-$name.txt" || exit 1; \
    done
RUN if [ "$INSTALL_BROWSER" = "true" ]; then .venv-workers/bin/playwright install --with-deps chromium; fi \
 && chmod -R a+rX /opt/playwright /opt/uv-python 2>/dev/null || true

# 2) Node paketlari
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 3) Kod
COPY --chown=node:node . .
RUN mkdir -p /data /home/node/.openclaw && chown -R node:node /data /home/node /app

USER node
ENV HOME=/home/node \
    JARVIS_PROJECT_DIR=/app \
    JARVIS_DATA_DIR=/data \
    DASHBOARD_HOST=0.0.0.0

EXPOSE 7890
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:18789/health >/dev/null || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/supervisor.js"]
