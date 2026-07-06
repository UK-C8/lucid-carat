FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time env vars are injected via --build-arg in CI
ARG SESSION_SECRET
ARG LC_DATABASE_URL
ARG LC_APP_DATABASE_URL
ARG STRIPE_SECRET_KEY
ARG STRIPE_WEBHOOK_SECRET
ARG STRIPE_PRICE_SEAT
ARG STRIPE_PRICE_STONE
ARG NEXT_PUBLIC_APP_URL

ENV SESSION_SECRET=$SESSION_SECRET \
    LC_DATABASE_URL=$LC_DATABASE_URL \
    LC_APP_DATABASE_URL=$LC_APP_DATABASE_URL \
    STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY \
    STRIPE_WEBHOOK_SECRET=$STRIPE_WEBHOOK_SECRET \
    STRIPE_PRICE_SEAT=$STRIPE_PRICE_SEAT \
    STRIPE_PRICE_STONE=$STRIPE_PRICE_STONE \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

COPY --from=builder /app/public           ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]
