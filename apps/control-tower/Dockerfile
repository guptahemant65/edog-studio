# syntax=docker/dockerfile:1
# Multi-stage build for the Control Tower (Next.js 15 standalone server).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Strip non-ASCII from build output: the Azure CLI's ACR log streamer crashes on
# Next's Unicode banner glyphs (▲/✓) when run from a Windows cp1252 console.
# pipefail keeps a real build failure fatal despite the filter.
SHELL ["/bin/ash", "-o", "pipefail", "-c"]
RUN npm run build 2>&1 | tr -cd '\t\n\r -~'

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone output: a self-contained server plus the static assets.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
