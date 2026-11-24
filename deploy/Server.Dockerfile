FROM golang:1.27.4 AS sftp
WORKDIR /src
COPY src/Sftp/go.mod src/Sftp/go.sum ./
RUN go mod download
COPY src/Sftp/*.go ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o /out/filesharing-sftp .

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json .
COPY src/Server/FileSharing.Server.csproj src/Server/packages.lock.json src/Server/
RUN dotnet restore src/Server/FileSharing.Server.csproj --locked-mode
COPY src/Server/ src/Server/
RUN dotnet publish src/Server/FileSharing.Server.csproj -c Release --no-restore -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0.15
ARG FILESHARING_UID=$APP_UID
WORKDIR /app
COPY --from=build /out/ ./
COPY --from=sftp /out/filesharing-sftp ./
RUN mkdir -m 700 /data && chown "$FILESHARING_UID:$FILESHARING_UID" /data
USER $FILESHARING_UID
ENTRYPOINT ["sh", "-c", "umask 077; exec dotnet FileSharing.Server.dll"]
