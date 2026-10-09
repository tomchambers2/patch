#!/bin/sh
# Your own Patch server, on a fresh Linux box, in one command, with HTTPS.
#
#   curl -fsSL https://github.com/tomchambers2/patch/releases/latest/download/install.sh | sudo sh
#   curl -fsSL https://github.com/tomchambers2/patch/releases/latest/download/install.sh | sudo sh -s -- --domain patch.example.com
#
# What it does, and nothing you have to answer:
#   1. Makes a `patch` user and installs the server release into
#      /var/lib/patch-server as a systemd service (spec/11 § Server installation).
#   2. Provisions Node 22 into that home if the box has no Node 20+.
#   3. Puts Caddy in front of it for HTTPS — a certificate from Let's Encrypt for
#      --domain, or, with no domain, for <your-ip>.sslip.io, a name that
#      resolves to your IP so there is nothing to register or point.
#   4. Makes the server's account and prints a QR to scan with the Patch app or
#      the desktop app. Run `patch-server pair` for another whenever you like.
#
# Run it again to upgrade. It needs ports 80 and 443 reachable from outside (the
# certificate is issued over them) and nothing else listening there.
#
# Options
#   --domain NAME        the name the server answers to (DNS must already point here)
#   --email ADDR         where Let's Encrypt may write about the certificate
#   --no-https           serve plain HTTP on :3000 instead — a LAN or a tunnel
#   --user-mode          no root: install under ~/.patch-server as your own user
#                        service, plain HTTP. For trying it out.
#   --release-url URL    the release tarball (its checksum is at URL.sha256)
#   --home DIR           where the server lives (default /var/lib/patch-server)
#   --no-service         lay the release out and stop: no service, no HTTPS, no
#                        pairing. For a box without systemd.
#
# NO FALLBACKS: a checksum that does not match, a port already taken, a
# certificate that does not arrive — each stops here and says why.
set -eu

DEFAULT_RELEASE_URL="https://github.com/tomchambers2/patch/releases/latest/download/patch-server.tar.gz"
RELEASE_URL="${PATCH_RELEASE_URL:-${DEFAULT_RELEASE_URL}}"
DOMAIN=""
EMAIL=""
HTTPS=1
USER_MODE=0
PRINT_CADDYFILE=0
SERVICE=1
HOME_DIR=""
PORT=3000

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --domain=*) DOMAIN="${1#--domain=}"; shift ;;
    --email) EMAIL="$2"; shift 2 ;;
    --email=*) EMAIL="${1#--email=}"; shift ;;
    --no-https) HTTPS=0; shift ;;
    --user-mode) USER_MODE=1; HTTPS=0; shift ;;
    --release-url) RELEASE_URL="$2"; shift 2 ;;
    --release-url=*) RELEASE_URL="${1#--release-url=}"; shift ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --home=*) HOME_DIR="${1#--home=}"; shift ;;
    --no-service) SERVICE=0; HTTPS=0; shift ;;
    --print-caddyfile) PRINT_CADDYFILE=1; shift ;;
    -h|--help) if [ -r "$0" ]; then sed -n '2,36p' "$0"; else echo "see the header of install-server.sh"; fi; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done

# --- The name the server answers to ---------------------------------------------

public_ip() {
  if [ -n "${PATCH_INSTALL_PUBLIC_IP:-}" ]; then printf '%s' "${PATCH_INSTALL_PUBLIC_IP}"; return; fi
  curl -4 -fsS --max-time 10 https://api.ipify.org || die "could not find this box's public IP — pass --domain"
}

resolve_domain() {
  [ -z "${DOMAIN}" ] || return 0
  IP=$(public_ip)
  case "${IP}" in
    *[!0-9.]*|"") die "'${IP}' is not an IPv4 address — pass --domain" ;;
  esac
  DOMAIN="$(printf '%s' "${IP}" | tr . -).sslip.io"
}

caddyfile() {
  printf '{\n'
  [ -z "${EMAIL}" ] || printf '\temail %s\n' "${EMAIL}"
  printf '}\n\n%s {\n' "${DOMAIN}"
  printf '\tencode zstd gzip\n'
  # /audio/* is the SERVER's (it relays the session to the chat's own host);
  # only /device/* belongs to this box's host (spec/07 § Reaching a non-home
  # host's audio WSS).
  printf '\t@device path /device/*\n'
  printf '\treverse_proxy @device 127.0.0.1:3003\n'
  printf '\treverse_proxy 127.0.0.1:%s\n' "${PORT}"
  printf '}\n'
}

if [ "${PRINT_CADDYFILE}" = 1 ]; then
  resolve_domain
  caddyfile
  exit 0
fi

# --- This box ---------------------------------------------------------------------

[ "$(uname -s)" = Linux ] || die "this installs onto Linux; this is $(uname -s)"
case "${PATCH_INSTALL_UNAME_M:-$(uname -m)}" in
  x86_64|amd64) NODE_ARCH=x64; CADDY_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; CADDY_ARCH=arm64 ;;
  *) die "no Node build for $(uname -m) here" ;;
esac
for tool in curl tar sha256sum; do
  command -v "${tool}" >/dev/null || die "${tool} is needed and is not installed"
done

if [ "${USER_MODE}" = 1 ]; then
  [ "$(id -u)" != 0 ] || die "--user-mode is for a normal user; as root, leave it off"
  SERVER_USER=$(id -un)
  : "${HOME_DIR:=${HOME}/.patch-server}"
else
  [ "$(id -u)" = 0 ] || die "this needs root. Run:  curl -fsSL <url>/install.sh | sudo sh   (or add --user-mode to try it as yourself)"
  command -v systemctl >/dev/null || die "systemd is needed (no systemctl here); use --user-mode ... or install by hand (spec/11)"
  SERVER_USER=patch
  : "${HOME_DIR:=/var/lib/patch-server}"
fi

if [ "${HTTPS}" = 1 ]; then
  resolve_domain
  PUBLIC_URL="https://${DOMAIN}"
else
  # Plain HTTP: the box's own address, which is what a phone on the LAN can use.
  HOST_FOR_URL="${DOMAIN:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
  [ -n "${HOST_FOR_URL}" ] || HOST_FOR_URL=127.0.0.1
  PUBLIC_URL="http://${HOST_FOR_URL}:${PORT}"
fi

# --- A user to run it as ----------------------------------------------------------

if [ "${USER_MODE}" = 0 ]; then
  say "Setting up the '${SERVER_USER}' user"
  if ! id "${SERVER_USER}" >/dev/null 2>&1; then
    useradd --system --home-dir "${HOME_DIR}" --create-home --shell /usr/sbin/nologin "${SERVER_USER}"
  fi
  mkdir -p "${HOME_DIR}"
  chown "${SERVER_USER}" "${HOME_DIR}"
fi

# --- Node ---------------------------------------------------------------------------

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }

provision_node() {
  say "Installing Node 22 into ${HOME_DIR}/node"
  BASE="${PATCH_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"
  SUMS=$(curl -fsS "${BASE}/SHASUMS256.txt") || die "could not fetch ${BASE}/SHASUMS256.txt"
  FILE=$(printf '%s\n' "${SUMS}" | awk -v a="linux-${NODE_ARCH}.tar.gz" '$2 ~ a"$" {print $2}')
  [ -n "${FILE}" ] || die "no linux-${NODE_ARCH} Node build in ${BASE}"
  WANT=$(printf '%s\n' "${SUMS}" | awk -v f="${FILE}" '$2 == f {print $1}')
  TMP=$(mktemp -d)
  curl -fsS "${BASE}/${FILE}" -o "${TMP}/node.tar.gz" || die "could not download ${BASE}/${FILE}"
  GOT=$(sha256sum "${TMP}/node.tar.gz" | awk '{print $1}')
  [ "${GOT}" = "${WANT}" ] || die "the Node download does not match its published checksum (${GOT} vs ${WANT})"
  rm -rf "${HOME_DIR}/node"
  mkdir -p "${HOME_DIR}/node"
  tar -xzf "${TMP}/node.tar.gz" -C "${HOME_DIR}/node" --strip-components=1
  rm -rf "${TMP}"
}

if [ -x "${HOME_DIR}/node/bin/node" ]; then
  :
elif node_ok; then
  :
else
  mkdir -p "${HOME_DIR}"
  provision_node
fi

# --- The release --------------------------------------------------------------------

say "Fetching the Patch server"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
curl -fsSL "${RELEASE_URL}" -o "${WORK}/release.tar.gz" || die "could not download ${RELEASE_URL}"
WANT=$(curl -fsSL "${RELEASE_URL}.sha256" | awk '{print $1}') || die "could not download ${RELEASE_URL}.sha256"
[ -n "${WANT}" ] || die "${RELEASE_URL}.sha256 is empty"
GOT=$(sha256sum "${WORK}/release.tar.gz" | awk '{print $1}')
[ "${GOT}" = "${WANT}" ] || die "the download does not match its published checksum (${GOT} vs ${WANT}) — not installing it"
tar -xzf "${WORK}/release.tar.gz" -C "${WORK}"
REL_DIR=$(ls -d "${WORK}"/patch-server-* 2>/dev/null | head -n 1)
[ -n "${REL_DIR}" ] && [ -x "${REL_DIR}/install" ] || die "the download is not a Patch server release"

NO_SERVICE_FLAG=""
[ "${SERVICE}" = 1 ] || NO_SERVICE_FLAG="--no-service"
say "Installing it (${PUBLIC_URL})"
if [ "${USER_MODE}" = 1 ]; then
  sh "${REL_DIR}/install" --home "${HOME_DIR}" --public-url "${PUBLIC_URL}" --host 0.0.0.0 ${NO_SERVICE_FLAG}
else
  HOST_BIND=127.0.0.1
  # Without HTTPS nothing sits in front of it, so it has to listen for itself.
  [ "${HTTPS}" = 1 ] || HOST_BIND=0.0.0.0
  sh "${REL_DIR}/install" --system --user "${SERVER_USER}" --home "${HOME_DIR}" \
    --public-url "${PUBLIC_URL}" --host "${HOST_BIND}" ${NO_SERVICE_FLAG}
  # `patch-server pair` must run as the server's user: the credential it keeps is
  # that user's, and root-owned files in the data directory would stop the server.
  cat > /usr/local/bin/patch-server <<WRAP
#!/bin/sh
exec runuser -u ${SERVER_USER} -- ${HOME_DIR}/current/patch-server "\$@"
WRAP
  chmod 755 /usr/local/bin/patch-server
fi

if [ "${SERVICE}" = 0 ]; then
  printf '\nLaid out in %s. Start it with PATCH_SERVER_HOME=%s PATCH_NODE=<node> %s/current/patch-server\n' "${HOME_DIR}" "${HOME_DIR}" "${HOME_DIR}"
  exit 0
fi

# --- HTTPS -----------------------------------------------------------------------------

if [ "${HTTPS}" = 1 ]; then
  say "Putting HTTPS in front of it (Caddy, certificate for ${DOMAIN})"
  for p in 80 443; do
    if command -v ss >/dev/null && ss -ltn "sport = :${p}" 2>/dev/null | tail -n +2 | grep -q . \
      && ! systemctl is-active --quiet patch-caddy; then
      die "something is already listening on port ${p}; Patch needs 80 and 443 for its certificate. Stop it, or install with --no-https behind your own proxy."
    fi
  done
  if [ ! -x /usr/local/bin/caddy ]; then
    CADDY_URL="${PATCH_CADDY_URL:-https://caddyserver.com/api/download?os=linux&arch=${CADDY_ARCH}}"
    curl -fsSL "${CADDY_URL}" -o /usr/local/bin/caddy.new || die "could not download Caddy from ${CADDY_URL}"
    chmod 755 /usr/local/bin/caddy.new
    mv /usr/local/bin/caddy.new /usr/local/bin/caddy
  fi
  id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
  mkdir -p /etc/patch
  caddyfile > /etc/patch/Caddyfile
  cat > /etc/systemd/system/patch-caddy.service <<UNIT
# Written by the Patch server installer. Re-running it rewrites this file.
[Unit]
Description=Patch HTTPS (Caddy)
After=network-online.target

[Service]
User=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/patch/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/patch/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable patch-caddy >/dev/null 2>&1
  systemctl restart patch-caddy

  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
  fi

  say "Waiting for the certificate"
  i=0
  while ! curl -fsS --max-time 5 "${PUBLIC_URL}/api/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 60 ]; then
      journalctl -u patch-caddy --no-pager -n 30 >&2 || true
      die "${PUBLIC_URL} did not answer within 3 minutes. The server itself is installed and running on :${PORT}. Check that ${DOMAIN} points at this box and that ports 80 and 443 are open to the internet (the log above says what Caddy saw)."
    fi
    sleep 3
  done
fi

# --- The first device ------------------------------------------------------------------------

say "Pairing your first device"
if [ "${USER_MODE}" = 1 ]; then
  "${HOME_DIR}/current/patch-server" pair
else
  patch-server pair
fi
printf '\nYour server is %s\n' "${PUBLIC_URL}"
printf 'Another device:     patch-server pair\n'
printf 'Upgrade:            run this same command again\n'
