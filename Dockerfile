FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=10000:10000 src ./src
COPY --chown=10000:10000 config ./config

USER 10000:10000
EXPOSE 3000
CMD ["npm", "start"]
