# agent-container — all-in-one agent image: OpenCode + acp-connector +
# assistant template + Node + Chromium. Each container = one isolated agent.
# State (identity, browser profile, config) lives in the /data volume.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates tar unzip git chromium \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# OpenCode (free models, no API key needed)
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:$PATH"

# acp-connector via npm — version-pinnable (ACP_CONNECTOR_VERSION build arg)
ARG ACP_CONNECTOR_VERSION=latest
RUN npm install -g "acp-connector@${ACP_CONNECTOR_VERSION}"

# assistant template — git clone so `npm run update` keeps working inside
RUN git clone --depth 1 https://github.com/galiprandi/assistant /opt/assistant \
  && rm -rf /opt/assistant/.git

WORKDIR /data
VOLUME /data

COPY container/entrypoint.sh /usr/local/bin/agent-entrypoint
RUN chmod +x /usr/local/bin/agent-entrypoint

CMD ["agent-entrypoint"]
