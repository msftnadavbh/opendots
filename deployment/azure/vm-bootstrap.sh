#!/bin/bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
test "$(id -u)" = 0
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 24.04
test "$(dpkg --print-architecture)" = amd64
timeout 600 cloud-init status --wait >/dev/null
GNUPGHOME=$(mktemp -d /run/opendots-gpg.XXXXXX)
export GNUPGHOME
trap 'rm -rf -- "$GNUPGHOME"; test -z "${key:-}" || rm -f -- "$key"' EXIT
fingerprint() {
  gpg --batch --show-keys --with-colons "$1" 2>/dev/null |
    awk -F: '$1=="pub" {primary=1} $1=="fpr" && primary {print $10;primary=0}'
}

if ! dpkg-query -W -f='${Status}' azure-vm-utils 2>/dev/null | grep -qx 'install ok installed'; then
  apt-get -o DPkg::Lock::Timeout=600 update -qq
  apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends azure-vm-utils
fi
command -v azure-nvme-id >/dev/null
dpkg-query -L azure-vm-utils | grep -q '/udev/rules.d/80-azure-disk.rules$'
udevadm control --reload-rules
udevadm trigger --subsystem-match=block --action=change
udevadm settle --timeout=30

if ! command -v docker >/dev/null; then
  apt-get -o DPkg::Lock::Timeout=600 update -qq
  apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/opendots-docker.asc
  test "$(fingerprint /etc/apt/keyrings/opendots-docker.asc)" = 9DC858229FC7DD38854AE2D88D81803C0EBFCD88
  chmod 0644 /etc/apt/keyrings/opendots-docker.asc
  cat >/etc/apt/sources.list.d/opendots-docker.sources <<'REPO'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/opendots-docker.asc
REPO
  chmod 0644 /etc/apt/sources.list.d/opendots-docker.sources
  apt-get -o DPkg::Lock::Timeout=600 update -qq
  apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends docker-ce docker-ce-cli containerd.io
fi
systemctl enable --now docker.service
docker_major=$(docker version --format '{{.Server.Version}}' | cut -d. -f1)
[[ "$docker_major" =~ ^[0-9]+$ ]] && ((docker_major >= 28))

if ! command -v caddy >/dev/null; then
  apt-get -o DPkg::Lock::Timeout=600 update -qq
  apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ca-certificates curl gnupg
  key=$(mktemp /run/opendots-caddy-key.XXXXXX)
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 60 https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$key"
  test "$(fingerprint "$key")" = 65760C51EDEA2017CEA2CA15155B6D79CA56EA34
  gpg --batch --yes --dearmor -o /usr/share/keyrings/opendots-caddy.gpg "$key"
  chmod 0644 /usr/share/keyrings/opendots-caddy.gpg
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/opendots-caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main' >/etc/apt/sources.list.d/opendots-caddy.list
  chmod 0644 /etc/apt/sources.list.d/opendots-caddy.list
  apt-get -o DPkg::Lock::Timeout=600 update -qq
  apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends caddy
fi
# The Caddy override and host-only configuration are installed before apt can start it.
test -d /var/lib/caddy
{ docker version --format '{{.Server.Version}}'; caddy version; azure-nvme-id --version; } >/etc/opendots/versions.txt
chmod 0644 /etc/opendots/versions.txt
