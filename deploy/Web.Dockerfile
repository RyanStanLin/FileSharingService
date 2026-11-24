FROM node:22-alpine AS build
WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM nginx:stable-alpine
COPY --from=build /src/dist/ /usr/share/nginx/html/
COPY deploy/nginx.paas.conf /etc/nginx/filesharing.conf
USER 10001:10001
ENTRYPOINT ["nginx", "-c", "/etc/nginx/filesharing.conf", "-g", "daemon off;"]
