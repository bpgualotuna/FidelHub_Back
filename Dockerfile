FROM node:22-slim

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y --no-install-recommends \
  openssl \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# install dependencies first for better caching
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

# Prisma generator needs the schema copy before generation
COPY prisma ./prisma
RUN npx prisma generate

# copy application source
COPY . .

RUN pnpm run build

# Copy and setup entrypoint script
COPY docker-entrypoint.sh /usr/src/app/docker-entrypoint.sh
RUN chmod +x /usr/src/app/docker-entrypoint.sh

EXPOSE 3001

ENTRYPOINT ["/usr/src/app/docker-entrypoint.sh"]
CMD ["pnpm", "run", "start:prod"]
