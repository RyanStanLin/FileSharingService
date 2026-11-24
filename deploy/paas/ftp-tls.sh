#!/bin/sh
set -eu
umask 077

repository="$1"
hostname=ftp-filesharing.ryanl.in
acme_dir=/var/lib/paas-acme/private
certificate="$acme_dir/certificates/filesharing-ftp.crt"
uid=$(id -u paas-runtime)

docker() {
    runuser -u paas-runtime -- /opt/personal-paas/docker/bin/docker \
        --host "unix:///run/user/$uid/docker.sock" "$@"
}

if ! openssl x509 -in "$certificate" -noout -checkend 2592000 >/dev/null 2>&1; then
    runuser -u paas-acme --preserve-environment -- /usr/local/bin/lego run \
        --path "$acme_dir" --email "$ACME_EMAIL" --dns cloudflare \
        --domains "$hostname" --cert.name filesharing-ftp --accept-tos --renew-days 30 \
        --dns.resolvers 1.1.1.1:53 --dns.resolvers 1.0.0.1:53
fi
openssl x509 -in "$certificate" -noout -checkhost "$hostname" -checkend 0
serial=$(openssl x509 -in "$certificate" -noout -serial | cut -d= -f2)

server=$(docker ps -q --filter label=in.ryanl.paas.managed=true \
    --filter "label=in.ryanl.paas.repository=$repository" --filter label=in.ryanl.paas.service=server)
volume="paas-$repository-ftp-tls"
if [ -n "$server" ]; then
    volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/certs"}}{{.Name}}{{end}}{{end}}' "$server")
fi
case "$volume" in
    "paas-$repository-"*) ;;
    *) printf 'Unexpected FileSharing certificate volume\n' >&2; exit 1 ;;
esac
if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume create --label in.ryanl.paas.managed=true \
        --label "in.ryanl.paas.repository=$repository" "$volume" >/dev/null
fi

helper=$(python3 -c 'import json; print(json.load(open("/etc/personal-paas/policy.json"))["helperImage"])')
updated=$(
    tar -C "$acme_dir/certificates" -cf - filesharing-ftp.crt filesharing-ftp.key |
        docker run --rm -i --read-only --network none --cap-drop ALL --cap-add CHOWN \
            --security-opt no-new-privileges --memory 32m --pids-limit 16 \
            --mount "type=volume,src=$volume,dst=/certs" "$helper" sh -eu -c '
                umask 077
                version="cert-$1"
                if [ "$(readlink /certs/current)" = "$version" ]; then
                    cat >/dev/null
                    exit 0
                fi
                stage=$(mktemp -d /certs/.cert.XXXXXXXX)
                trap "rm -rf \"$stage\"" EXIT
                tar --no-same-owner -xf - -C "$stage"
                mv "$stage/filesharing-ftp.crt" "$stage/fullchain.pem"
                mv "$stage/filesharing-ftp.key" "$stage/privkey.pem"
                chmod 0640 "$stage/fullchain.pem" "$stage/privkey.pem"
                chmod 0750 "$stage" /certs
                chown 0:10001 "$stage" "$stage/fullchain.pem" "$stage/privkey.pem" /certs
                if [ ! -d "/certs/$version" ]; then
                    mv "$stage" "/certs/$version"
                fi
                ln -sfn "$version" /certs/.next
                mv -fT /certs/.next /certs/current
                printf "updated\n"
            ' filesharing-certificate "$serial"
)
if [ "$updated" = updated ] && [ -n "$server" ]; then
    docker restart --time 30 "$server" >/dev/null
fi
