# JARVIS — server (headless) rejimi: Telegram bot, avtonom missiyalar, agentlar, dashboard.
# Mikrofon / ekran / iPhone / doim eshitish faqat Mac'da ishlaydi (Docker'da yo'q).
FROM node:22-bookworm-slim

ARG OPENCLAW_VERSION=2026.7.1-2
ARG INSTALL_BROWSER=true

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    TIKTOKEN_CACHE_DIR=/opt/tiktoken \
    LITELLM_LOCAL_MODEL_COST_MAP=True

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl ca-certificates git ffmpeg procps tini build-essential libffi-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN npm install -g "openclaw@${OPENCLAW_VERSION}" && npm cache clean --force

WORKDIR /app

# 1) Python muhitlari (requirements/*.txt — aniq versiyalar; macOS'ga xos pyobjc tashlab ketiladi).
#    Kod o'zgarganda bu qatlamlar qayta qurilmaydi.
#    --no-deps: fayllar `pip freeze` natijasi (barcha bog'liqlik aniq berilgan) — aynan sinalgan muhit tiklanadi.
#    (AutoGPT ro'yxatida pip jim o'tkazgan versiya ziddiyati bor; uv qat'iy hal qilganda rad etardi.)
COPY requirements/workers.txt requirements/babyagi.txt requirements/autogpt.txt requirements/
RUN uv python install 3.11 3.12 \
 && for spec in workers:3.12 babyagi:3.12 autogpt:3.11; do \
      name="${spec%%:*}"; py="${spec##*:}"; \
      uv venv --python "$py" ".venv-$name" \
      && grep -viE '^pyobjc' "requirements/$name.txt" > "/tmp/req-$name.txt" \
      && uv pip install --no-deps --python ".venv-$name/bin/python" -r "/tmp/req-$name.txt" || exit 1; \
    done
# interpreter.txt to'liq freeze emas (asosiy paketlar + setuptools<82: pkg_resources kerak) — bog'liqliklari odatdagidek hal qilinadi.
COPY requirements/interpreter.txt requirements/
RUN uv venv --python 3.11 .venv-interpreter && uv pip install --python .venv-interpreter/bin/python -r requirements/interpreter.txt
RUN if [ "$INSTALL_BROWSER" = "true" ]; then .venv-workers/bin/playwright install --with-deps chromium; fi \
 && chmod -R a+rX /opt/playwright /opt/uv-python 2>/dev/null || true

# Sovuq ishga tushishda tiktoken/litellm internetdan yuklab, ishchining "to'xtash" taymeridan o'tib ketardi
# (sinovda birinchi missiyada Interpreter shu sabab to'xtagan). Oldindan yuklab qo'yamiz.
RUN mkdir -p /opt/tiktoken && chmod a+rwX /opt/tiktoken \
 && .venv-interpreter/bin/python -c "import tiktoken; [tiktoken.get_encoding(n) for n in ('cl100k_base','o200k_base')]; import litellm; print('warm-up ok')"

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
