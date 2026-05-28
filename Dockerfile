FROM node:20-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile

COPY apps/api ./apps/api

RUN pnpm prisma generate --schema=prisma/schema.prisma
RUN pnpm --filter api build

ENV NODE_ENV=production
ENV API_PORT=3001
ENV API_HOST=0.0.0.0

EXPOSE 3001

WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
