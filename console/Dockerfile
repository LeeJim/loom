FROM node:22-bookworm AS build
WORKDIR /console
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm
COPY --from=build /console/dist /opt/loom-console/dist
RUN mkdir -p /opt/loom-console/bin && cp /usr/local/bin/node /opt/loom-console/bin/node
