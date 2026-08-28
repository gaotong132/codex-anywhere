FROM node:24-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts ./
COPY web ./web
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=web-build /app/build ./build
COPY --from=web-build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0
ENV PORT=3300
EXPOSE 3300
USER node
ENTRYPOINT ["node"]
CMD ["build/server/index.js"]
