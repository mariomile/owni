# Owni: one tenant per container. Data lives in the /data volume.
FROM node:24.22.1-bookworm-slim

ENV NODE_ENV=production \
    OWNI_DATA_DIR=/data \
    OWNI_WEB_HOST=0.0.0.0 \
    OWNI_WEB_PORT=8080

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

# Screenshots of web pages (web_screenshot) need Chromium: docker build --build-arg WITH_BROWSER=1 .
# Without it the image is ~400 MB lighter and Owni still reads pages (web_read).
ARG WITH_BROWSER=
RUN if [ -n "$WITH_BROWSER" ]; then apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation && rm -rf /var/lib/apt/lists/*; fi
ENV OWNI_CHROMIUM_PATH=${WITH_BROWSER:+/usr/bin/chromium}

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY src ./src
COPY evals/segreteria/checks.json ./evals/segreteria/checks.json
COPY LICENSE NOTICE ./

# Run as the unprivileged user of the image; /data must be writable by it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OWNI_WEB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx runs the TypeScript sources directly (parameter properties need a transform).
CMD ["node_modules/.bin/tsx", "src/main/owni.ts"]
