FROM node:24-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=web-build /app/dist ./dist
ENV HOST=0.0.0.0
ENV PORT=3300
EXPOSE 3300
USER node
ENTRYPOINT ["node"]
CMD ["src/server/index.js"]
