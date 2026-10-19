FROM python:3.11-slim-bookworm AS fixtures
WORKDIR /app
COPY requirements-fixtures.txt ./
RUN pip install --no-cache-dir -r requirements-fixtures.txt
COPY scripts/generate_samples.py scripts/generate_samples.py
COPY assets/ai-steel-textures.json assets/ai-steel-provenance.json assets/
RUN python scripts/generate_samples.py

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
COPY --from=fixtures /app/public ./public
ARG SCRAP_SOURCE_COMMIT=local
ENV SCRAP_SOURCE_COMMIT=$SCRAP_SOURCE_COMMIT
RUN npm run assets && npm test && npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
