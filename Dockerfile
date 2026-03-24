# Use Node.js LTS version
FROM node:20-slim

# Install OpenSSL (required by Prisma)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Install dependencies (including devDependencies for Prisma)
COPY package*.json ./
RUN npm install

# Copy Prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy the rest of the app
COPY . .

# Remove dev dependencies for production (Prisma CLI is now in dependencies)
RUN npm prune --production

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodeuser && \
    chown -R nodeuser:nodejs /usr/src/app

# Switch to non-root user
USER nodeuser

# Expose the port
EXPOSE 80

# Set environment
ENV NODE_ENV=production
ENV PORT=80

# Start script (runs migrate deploy before app starts)
CMD npx prisma migrate deploy && npm start
