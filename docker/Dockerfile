# The party server in a container: the very same `agents-party web` the CLI runs, nothing forked.
#
#   docker build -t agents-party .
#   docker run -d -p 7799:7799 -v agents-party:/data -e AGENTS_PARTY_SERVER_TOKEN=<secret> agents-party
#
# The version is a build arg, so an image is a fixed version of the package: bump it and rebuild to upgrade.

FROM node:24-alpine

ARG AGENTS_PARTY_VERSION=latest
RUN npm install -g agents-party@${AGENTS_PARTY_VERSION}

# Everything the server owns lives here: registry.sqlite plus one file per party. Mount a volume on it
# or the parties die with the container.
ENV AGENTS_PARTY_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 7799

# The capability probe is the cheapest honest liveness check: no auth, no store access.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:7799/api/server').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# `--host 0.0.0.0` because the port has to be reachable from outside the container. That also makes
# AGENTS_PARTY_SERVER_TOKEN mandatory: beyond loopback the server refuses to start without one.
CMD ["agents-party", "web", "--host", "0.0.0.0", "--port", "7799"]
