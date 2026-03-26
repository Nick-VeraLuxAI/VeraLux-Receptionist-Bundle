# VeraLux brain — OpenAI-compatible LLM gateway for voice-runtime (/reply, /reply/stream).
# Build context: repository root (see docker-compose service `brain`).
# Uses vLLM or OpenAI depending on OPENAI_BASE_URL / OPENAI_API_KEY at runtime.

FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY veralux-voice-runtime/brain-gpt4o/package.json veralux-voice-runtime/brain-gpt4o/package-lock.json veralux-voice-runtime/brain-gpt4o/

RUN npm ci -w brain-gpt4o -w @veralux/shared --ignore-scripts

COPY shared/ shared/
COPY veralux-voice-runtime/brain-gpt4o/tsconfig.json veralux-voice-runtime/brain-gpt4o/
COPY veralux-voice-runtime/brain-gpt4o/src veralux-voice-runtime/brain-gpt4o/src/

RUN npm run build -w @veralux/shared

WORKDIR /app/veralux-voice-runtime/brain-gpt4o
RUN npm run build

# ---

FROM node:20-alpine

RUN apk add --no-cache wget

RUN addgroup -g 1001 -S veralux && \
    adduser -S veralux -u 1001 -G veralux

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY veralux-voice-runtime/brain-gpt4o/package.json veralux-voice-runtime/brain-gpt4o/

RUN npm ci -w brain-gpt4o -w @veralux/shared --omit=dev --ignore-scripts

COPY --from=builder /app/shared/dist shared/dist/
COPY --from=builder /app/veralux-voice-runtime/brain-gpt4o/dist veralux-voice-runtime/brain-gpt4o/dist/

WORKDIR /app/veralux-voice-runtime/brain-gpt4o

RUN chown -R veralux:veralux /app
USER veralux

EXPOSE 3001

CMD ["node", "dist/index.js"]
