FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --production

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Create data directory
RUN mkdir -p data && chmod 777 data

EXPOSE 17878

ENV NODE_ENV=production

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
