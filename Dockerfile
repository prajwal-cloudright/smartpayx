# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci

COPY . .

RUN npm run build

# ─── Stage 2: Production runtime ──────────────────────────────────────────────
FROM node:22-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json* ./
COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma

RUN npm ci --omit=dev && npm cache clean --force

EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]