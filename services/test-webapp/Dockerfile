# syntax=docker/dockerfile:1.7
# Multi-stage Next.js standalone build.
# Final image is ~120 MB on linux/arm64; runs as non-root.

# --- deps stage: install only production deps, cached on package.json changes ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
# Use npm install (not ci) because this service has no committed lockfile
# yet; once we settle on a lockfile strategy across services we can switch
# to npm ci for reproducibility.
RUN npm install --omit=dev --no-audit --no-fund

# --- builder stage: full install + next build ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# Next.js output: "standalone" emits .next/standalone + .next/static
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runner stage: just node + the standalone bundle ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user. uid matches the agent service for consistency.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Copy only the standalone bundle + static assets.
# The standalone output includes server.js + minimal node_modules for the app.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
