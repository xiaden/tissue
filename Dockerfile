# Base tag is intentionally kept on Node 26 bookworm-slim; pin the resolved digest in release/CI metadata.
FROM node:26-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Tissue shells out to the real binaries at these stable paths.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes git gh \
  && test -x /usr/bin/git \
  && test -x /usr/bin/gh \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY container ./container
COPY agents ./agents
COPY plugin ./plugin

RUN chmod 0555 /app/container/entrypoint.sh /app/container/prepare-volumes.sh \
  && mkdir -p /var/lib/tissue/state /srv/tissue/worktrees /tissue-session-registry /tissue-moderation \
    /home/opencode/.config/opencode/plugins /home/opencode/.config/opencode/agents \
  && chown -R 1000:1000 /app /var/lib/tissue /srv/tissue /tissue-session-registry /tissue-moderation /home/opencode

USER 1000:1000
ENTRYPOINT ["/app/container/entrypoint.sh"]
