FROM node:22-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY controller.mjs ./
USER node
CMD ["node", "controller.mjs"]
