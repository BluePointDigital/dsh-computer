# Build from the repository root. Release operators should pin base digest and
# record installed certbot version/SBOM for their deployment.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update && apt-get install -y --no-install-recommends certbot util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/dsh-applications
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps --ignore-scripts
COPY --chown=node:node lib ./lib
COPY --chown=node:node bin/tls-cli.mjs bin/tls-worker.mjs ./bin/
ENV DSH_HOME=/data
USER node
CMD ["node", "bin/tls-worker.mjs"]
