#!/bin/bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
test "$(id -u)" = 0
helper=/usr/local/lib/opendots/vm-disk.py
registry=odpilot7unu3az5tgmza.azurecr.io
container=opendots-pilot

check_mount() { python3 "$helper" check >/dev/null; }
check_image_arg() { [[ "$1" =~ ^odpilot7unu3az5tgmza\.azurecr\.io/opendots@sha256:[a-f0-9]{64}$ ]]; }
check_operation() { [[ "$1" =~ ^[a-f0-9-]{36}$ ]]; }
check_backup() { [[ "$1" =~ ^backup-[a-f0-9-]{36}\.sqlite$ ]]; }
has_image() {
  docker image inspect "$1" --format '{{json .RepoDigests}}' 2>/dev/null |
    python3 -c 'import json,sys;sys.exit(0 if sys.argv[1] in json.load(sys.stdin) else 1)' "$1"
}

case "${1:-}" in
  image-present)
    test "$#" = 2; check_image_arg "$2"
    if has_image "$2"; then printf 'true\n'; else printf 'false\n'; fi
    ;;
  pull)
    test "$#" = 3; check_operation "$2"; check_image_arg "$3"
    export DOCKER_CONFIG="/run/opendots-registry-$2"
    mkdir -m 700 "$DOCKER_CONFIG"
    trap 'rm -rf -- "$DOCKER_CONFIG"' EXIT
    trap 'exit 1' HUP INT TERM
    timeout 60 docker login "$registry" --username opendots-pilot-import --password-stdin >/dev/null 2>&1
    timeout 600 docker pull "$3" >/dev/null 2>&1
    has_image "$3"
    ;;
  cleanup-pull)
    test "$#" = 2; check_operation "$2"
    rm -rf -- "/run/opendots-registry-$2"
    test ! -e "/run/opendots-registry-$2"
    ;;
  run)
    test "$#" = 2; check_image_arg "$2"; check_mount; has_image "$2"
    docker_major=$(docker version --format '{{.Server.Version}}' | cut -d. -f1)
    [[ "$docker_major" =~ ^[0-9]+$ ]] && ((docker_major >= 28))
    exec docker run --name "$container" --rm --pull=never --network bridge \
      --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,size=64m --pids-limit 256 --memory 3g --memory-swap 3g --cpus 1.75 \
      --publish 127.0.0.1:4310:4310/tcp --mount type=bind,src=/srv/opendots,dst=/data \
      --entrypoint /usr/local/bin/node "$2" /app/deployment/azure/start.mjs
    ;;
  configure)
    test "$#" = 1; check_mount
    docker exec -i --user 1000:1000 "$container" /usr/bin/timeout 60 /usr/local/bin/node /app/deployment/azure/vm-files.mjs configure
    ;;
  backup)
    test "$#" = 2; check_backup "$2"; check_mount
    docker exec --user 1000:1000 "$container" /usr/bin/timeout 300 /usr/local/bin/node /app/deployment/azure/vm-files.mjs backup "$2"
    ;;
  download)
    test "$#" = 2; check_backup "$2"; check_mount
    exec docker exec --user 1000:1000 "$container" /usr/bin/timeout 840 /usr/local/bin/node /app/deployment/azure/vm-files.mjs download "$2"
    ;;
  start|restart)
    test "$#" = 1; check_mount
    systemctl enable opendots.service >/dev/null
    systemctl "$1" opendots.service
    ;;
  stop)
    test "$#" = 1
    systemctl stop opendots.service
    ;;
  status)
    test "$#" = 1; check_mount
    systemctl is-active opendots.service
    ;;
  *) exit 1 ;;
esac
