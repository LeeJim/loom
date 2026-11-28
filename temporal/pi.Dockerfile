FROM node:24-bookworm-slim
ARG PI_VERSION=1.7.0
RUN test -n "$PI_VERSION" && npm install --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"
USER node
ENTRYPOINT ["pi"]
