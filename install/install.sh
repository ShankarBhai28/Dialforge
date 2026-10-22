#!/bin/bash
# VIZTEX installer - one fresh Ubuntu 24.04 server per client.
#
# Installs and wires together: MySQL, Asterisk 22 (built from source, ODBC
# realtime), coturn (TURN), a TLS certificate, the VIZTEX app (backend +
# dialer engine), nightly backups, recording conversion - then checks it all.
# About 30-45 minutes on 2 vCPU (most of it compiling Asterisk).
#
# Run on the new server from the unpacked release (scripts/make-release.sh):
#   sudo bash viztex/install/install.sh --domain voice.client.com --admin boss --email it@client.com
#
# Options:
#   --domain HOST       hostname agents open (DNS must point at this server) - required
#   --admin NAME        first Super Admin login - required
#   --email ADDR        for Let's Encrypt expiry mails (required unless --self-signed)
#   --timezone TZ       the center's time zone (default Asia/Kolkata)
#   --name TEXT         product name in alerts (default VIZTEX)
#   --self-signed       test install without a real certificate (browsers warn)
#   --public-ip IP      override the detected public IP
#   --firewall          also open the ports in ufw (cloud: use the security group)
#   --skip-asterisk-build   Asterisk 22 is already installed
#   --checks-only       run only the final checks (after fixing something, or on
#                       the telephony server once the app server is installed)
#
# One customer on three servers (Phase 1) - in this order, each on its own server:
#   --role db         MySQL only, reachable from the app and telephony servers
#                       --app-ip IP --telephony-ip IP    (their private IPs)
#   --role telephony  Asterisk + TURN + recordings
#                       --domain sip.client.com --email ... --db-ip IP --app-ip IP
#                       --secrets <the DB server's /etc/viztex/secrets.env>
#   --role app        the VIZTEX app + dialer
#                       --domain crm.client.com --admin ... --email ... --db-ip IP
#                       --telephony-ip IP --telephony-domain sip.client.com
#                       --secrets <the DB server's /etc/viztex/secrets.env>
#                       [--telephony-host NAME]  (default: ip-a-b-c-d from --telephony-ip)
#   Default --role all: everything on this one server (unchanged).
#
# Safe to run again: finished steps are skipped, secrets are kept
# (/etc/viztex/secrets.env), existing configs are backed up before changes.
set -euo pipefail

# ---------------------------------------------------------------- options
DOMAIN="" ADMIN="" EMAIL="" TZ_NAME="Asia/Kolkata" APP_NAME="VIZTEX"
SELF_SIGNED=0 PUBLIC_IP="" FIREWALL=0 SKIP_AST_BUILD=0 CHECKS_ONLY=0
ROLE=all APP_IP="" TEL_IP="" DB_IP="" TEL_DOMAIN="" TEL_HOST="" SECRETS_FROM="" ADMIN_PASSWORD_LINE=""
ASTERISK_VERSION="${ASTERISK_VERSION:-22.11.0}"
NODE_MAJOR=24
DB_NAME="viztex"
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --admin) ADMIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --timezone) TZ_NAME="$2"; shift 2 ;;
    --name) APP_NAME="$2"; shift 2 ;;
    --self-signed) SELF_SIGNED=1; shift ;;
    --public-ip) PUBLIC_IP="$2"; shift 2 ;;
    --firewall) FIREWALL=1; shift ;;
    --skip-asterisk-build) SKIP_AST_BUILD=1; shift ;;
    --checks-only) CHECKS_ONLY=1; shift ;;
    --role) ROLE="$2"; shift 2 ;;
    --app-ip) APP_IP="$2"; shift 2 ;;
    --telephony-ip) TEL_IP="$2"; shift 2 ;;
    --db-ip) DB_IP="$2"; shift 2 ;;
    --telephony-domain) TEL_DOMAIN="$2"; shift 2 ;;
    --telephony-host) TEL_HOST="$2"; shift 2 ;;
    --secrets) SECRETS_FROM="$2"; shift 2 ;;
    -h|--help) sed -n '2,43p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

case "$ROLE" in all | db | telephony | app) ;; *) echo "--role must be all, db, telephony or app" >&2; exit 2 ;; esac
# has <part>: does this server run that part? (all = every part)
has() { [ "$ROLE" = all ] || [ "$ROLE" = "$1" ]; }
SPLIT=0; [ "$ROLE" = all ] || SPLIT=1

HERE="$(cd "$(dirname "$0")" && pwd)"
RELEASE="$(dirname "$HERE")"                       # .../viztex
LOG=/var/log/viztex-install.log
STATE=/var/lib/viztex-install
SECRETS=/etc/viztex/secrets.env
TS=$(date +%Y%m%d-%H%M%S)

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*" | tee -a "$LOG"; }
info() { printf '   %s\n' "$*" | tee -a "$LOG"; }
warn() { printf '\033[1;33m   ! %s\033[0m\n' "$*" | tee -a "$LOG"; }
die()  { printf '\033[1;31mFAILED: %s\033[0m\n   Full log: %s\n' "$*" "$LOG" >&2; exit 1; }
done_step() { touch "$STATE/$1"; }
is_done() { [ -f "$STATE/$1" ]; }
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }
# The port this server's app really uses (an older .env may keep 3000) and its address.
app_port() {
  APP_PORT=$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -1)
  APP_PORT=${APP_PORT:-3000}
  APP_URL="https://$DOMAIN$([ "$APP_PORT" = 443 ] || echo ":$APP_PORT")"
}
# Writes a config file (backing up what was there), owner and mode.
put() { # put <file> <owner> <mode>  (content on stdin)
  local f="$1"
  if [ -f "$f" ] && [ ! -f "$f.viztex-orig" ]; then cp -p "$f" "$f.viztex-orig"; fi
  cat > "$f"
  chown "$2" "$f"
  chmod "$3" "$f"
}

# ---------------------------------------------------------------- preflight
[ "$(id -u)" = 0 ] || { echo "run with sudo: sudo bash $0 ..." >&2; exit 1; }
APP_USER="${SUDO_USER:-ubuntu}"
[ "$APP_USER" != root ] || die "run as a normal user with sudo (e.g. ubuntu), not as root"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
APP_DIR="$APP_HOME/dialforge-backend"   # internal name, same as every VIZTEX server
mkdir -p "$STATE" /etc/viztex
# The app (not root) reads licence.json here; each secret file is root-only itself.
chmod 755 /etc/viztex
: >> "$LOG"; chmod 600 "$LOG"

ipok() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
if has app || has telephony; then
  [ -n "$DOMAIN" ] || die "--domain is required (the hostname agents will open)"
  [ "$SELF_SIGNED" = 1 ] || [ -n "$EMAIL" ] || die "--email is required for the Let's Encrypt certificate (or use --self-signed to test)"
fi
if has app; then
  [ -n "$ADMIN" ] || die "--admin is required (the first Super Admin's username)"
  [[ "$ADMIN" =~ ^[A-Za-z0-9._-]{3,50}$ ]] || die "--admin: 3-50 letters, digits, dots, dashes or underscores"
fi
case "$ROLE" in
  db) ipok "$APP_IP" && ipok "$TEL_IP" || die "--role db needs --app-ip and --telephony-ip (the other servers' private IPs)"
      DOMAIN=${DOMAIN:-database} ;;
  telephony) ipok "$DB_IP" && ipok "$APP_IP" || die "--role telephony needs --db-ip and --app-ip (private IPs)" ;;
  app) ipok "$DB_IP" && ipok "$TEL_IP" && [ -n "$TEL_DOMAIN" ] ||
         die "--role app needs --db-ip, --telephony-ip and --telephony-domain (the name agents' phones connect to)"
       TEL_HOST=${TEL_HOST:-ip-${TEL_IP//./-}} ;;
esac
TEL_DOMAIN=${TEL_DOMAIN:-$DOMAIN}
ENV_FILE="$APP_DIR/.env"
[ -d "$RELEASE/app" ] || die "app/ not found next to install/ - unpack the whole release package"
. /etc/os-release
[ "$ID" = ubuntu ] && [ "${VERSION_ID%%.*}" -ge 24 ] || die "needs Ubuntu 24.04 (this is $PRETTY_NAME)"

say "VIZTEX install $(cat "$RELEASE/VERSION" 2>/dev/null || echo '?') - $DOMAIN$([ "$ROLE" = all ] || echo " (role: $ROLE)")"
info "app user: $APP_USER   app dir: $APP_DIR   log: $LOG"
# The nightly backup (runs as the app user) copies /etc/asterisk with sudo -n.
sudo -n -l -U "$APP_USER" 2>/dev/null | grep -q 'NOPASSWD: ALL' ||
  warn "$APP_USER has no password-free sudo: the nightly backup will skip the Asterisk config copy"

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
[ "$MEM_MB" -ge 3500 ] || warn "only ${MEM_MB} MB RAM - 4 GB or more recommended (Asterisk + MySQL + Node)"
[ "$DISK_GB" -ge 20 ] || warn "only ${DISK_GB} GB disk free - recordings need room (about 3.6 GB a day for 50 agents)"

PRIVATE_IP=$(ip -o -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
LOCAL_NET=$(ip -o -4 addr show | awk -v ip="$PRIVATE_IP" '$4 ~ "^"ip"/" {print $4}' |
  python3 -c 'import sys,ipaddress; print(ipaddress.ip_interface(sys.stdin.read().strip()).network)')
if [ -z "$PUBLIC_IP" ]; then
  TOKEN=$(curl -s -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
  [ -n "$TOKEN" ] && PUBLIC_IP=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
  [[ "$PUBLIC_IP" =~ ^[0-9.]+$ ]] || PUBLIC_IP=$(curl -s -m 5 https://checkip.amazonaws.com | tr -d '[:space:]')
fi
# The database server may have no public IP at all (private subnet).
ipok "$PUBLIC_IP" || [ "$ROLE" = db ] || die "couldn't find the public IP - pass --public-ip"
info "public IP ${PUBLIC_IP:-none}   private IP $PRIVATE_IP   local net $LOCAL_NET"

DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
if [ "$ROLE" != db ] && [ "$DNS_IP" != "$PUBLIC_IP" ]; then
  if [ "$SELF_SIGNED" = 1 ]; then
    warn "$DOMAIN resolves to '${DNS_IP:-nothing}', not $PUBLIC_IP - fine for a self-signed test"
  else
    die "$DOMAIN resolves to '${DNS_IP:-nothing}', not this server ($PUBLIC_IP). Point the DNS record here first (the certificate needs it)."
  fi
fi

# Secrets: made once, kept across re-runs. Split servers share one file:
# made by the DB server's install, copied to the others with --secrets.
if [ ! -f "$SECRETS" ] && [ -n "$SECRETS_FROM" ]; then
  [ -f "$SECRETS_FROM" ] || die "--secrets $SECRETS_FROM: file not found"
  install -m 600 "$SECRETS_FROM" "$SECRETS"
fi
if [ ! -f "$SECRETS" ] && [ "$ROLE" != all ] && [ "$ROLE" != db ]; then
  die "no $SECRETS yet: copy the DB server's /etc/viztex/secrets.env here and pass --secrets <file>"
fi
if [ ! -f "$SECRETS" ]; then
  umask 077
  cat > "$SECRETS" <<EOF
DB_PASSWORD=$(rand 32)
ASTERISK_RT_PASSWORD=$(rand 32)
ARI_PASS=$(rand 32)
AMI_PASS=$(rand 32)
SESSION_SECRET=$(rand 48)
TURN_SECRET=$(rand 40)
EOF
  umask 022
fi
chmod 600 "$SECRETS"
. "$SECRETS"

if [ "$CHECKS_ONLY" = 0 ]; then
# ---------------------------------------------------------------- 1. packages
if ! is_done packages; then
  say "1/9 System packages"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  timedatectl set-timezone UTC 2>/dev/null || true # the app stores UTC; reports use --timezone
  apt-get update -y >> "$LOG" 2>&1
  apt-get upgrade -y >> "$LOG" 2>&1
  PKGS="curl openssl ca-certificates gnupg python3"
  has db && PKGS="$PKGS mysql-server"
  has telephony && PKGS="$PKGS build-essential git wget subversion libncurses5-dev libssl-dev libxml2-dev
    libsqlite3-dev uuid-dev libjansson-dev pkg-config libedit-dev automake libtool unzip
    libsrtp2-dev unixodbc unixodbc-dev odbc-mariadb coturn certbot ffmpeg"
  has app && PKGS="$PKGS certbot mysql-client"
  # shellcheck disable=SC2086
  apt-get install -y $PKGS >> "$LOG" 2>&1 || die "apt-get install"
  if has app && ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
    curl -fsSL "https://deb.nodesource.com/setup_$NODE_MAJOR.x" | bash - >> "$LOG" 2>&1 || die "Node.js repository"
    apt-get install -y nodejs >> "$LOG" 2>&1 || die "Node.js"
  fi
  info "node $(node -v 2>/dev/null || echo -), mysql $(mysql --version 2>/dev/null | awk '{print $3}')"
  done_step packages
fi

# ---------------------------------------------------------------- 2. Asterisk
if has telephony && [ "$SKIP_AST_BUILD" = 0 ] && ! is_done asterisk-build; then
  if /usr/sbin/asterisk -V 2>/dev/null | grep -q "Asterisk 22\."; then
    info "Asterisk 22 already installed - not building again"
  else
    say "2/9 Asterisk $ASTERISK_VERSION (download + compile: 20-40 minutes, this is normal)"
    mkdir -p /usr/src/viztex && cd /usr/src/viztex
    TARBALL="asterisk-$ASTERISK_VERSION.tar.gz"
    [ -f "$TARBALL" ] || wget -q "https://downloads.asterisk.org/pub/telephony/asterisk/releases/$TARBALL" ||
      wget -q -O "$TARBALL" "https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.tar.gz" ||
      die "download Asterisk"
    rm -rf "asterisk-src" && mkdir asterisk-src && tar xzf "$TARBALL" -C asterisk-src --strip-components=1
    cd asterisk-src
    DEBIAN_FRONTEND=noninteractive contrib/scripts/install_prereq install >> "$LOG" 2>&1 || die "Asterisk prerequisites"
    ./configure >> "$LOG" 2>&1 || die "Asterisk configure"
    make menuselect.makeopts >> "$LOG" 2>&1
    # ODBC realtime (extensions / queues from MySQL), AMD for the dialer.
    menuselect/menuselect --enable res_odbc --enable res_config_odbc --enable app_amd \
      --enable app_mixmonitor menuselect.makeopts >> "$LOG" 2>&1 || die "Asterisk module selection"
    info "compiling with $(nproc) CPU(s)..."
    make -j"$(nproc)" >> "$LOG" 2>&1 || die "Asterisk compile"
    make install >> "$LOG" 2>&1 || die "Asterisk install"
    [ -f /etc/asterisk/asterisk.conf ] || make samples >> "$LOG" 2>&1
    ldconfig
  fi
  done_step asterisk-build
fi
if has telephony; then
/usr/sbin/asterisk -V >/dev/null 2>&1 || die "Asterisk is not installed"
id asterisk >/dev/null 2>&1 || useradd -r -d /var/lib/asterisk -s /usr/sbin/nologin asterisk
mkdir -p /etc/asterisk/keys /var/spool/asterisk/monitor/dialforge
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /usr/lib/asterisk
chmod 2775 /var/spool/asterisk/monitor/dialforge
fi

# ---------------------------------------------------------------- 3. MySQL
if has db; then
say "3/9 Database"
# Single server: only this server reaches MySQL (127.0.0.1). Split: the
# private IP, and each user only from its own server.
DB_BIND=127.0.0.1 APP_DBHOST=localhost RT_DBHOST=localhost
[ "$SPLIT" = 1 ] && DB_BIND=$PRIVATE_IP APP_DBHOST=$APP_IP RT_DBHOST=$TEL_IP
# MySQL only for this server. Not in mysql.conf.d/mysqld.cnf: odbc-mariadb
# pulls in mariadb-common, which points /etc/mysql/my.cnf at mariadb.cnf,
# and that never reads mysql.conf.d - conf.d is read by both.
put /etc/mysql/conf.d/viztex.cnf root:root 644 <<EOF
[mysqld]
bind-address = $DB_BIND
mysqlx-bind-address = 127.0.0.1
EOF
systemctl enable mysql >> "$LOG" 2>&1
if [ "$(mysql -N -e "SELECT @@bind_address" 2>/dev/null)" != "$DB_BIND" ]; then
  systemctl restart mysql >> "$LOG" 2>&1 || die "MySQL restart"
fi
mysql <<SQL || die "create database / users"
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'dialforge'@'$APP_DBHOST' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER 'dialforge'@'$APP_DBHOST' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO 'dialforge'@'$APP_DBHOST'$(if [ "$SPLIT" = 1 ]; then echo " WITH GRANT OPTION"; fi);
CREATE USER IF NOT EXISTS 'asterisk_rt'@'$RT_DBHOST' IDENTIFIED BY '$ASTERISK_RT_PASSWORD';
ALTER USER 'asterisk_rt'@'$RT_DBHOST' IDENTIFIED BY '$ASTERISK_RT_PASSWORD';
FLUSH PRIVILEGES;
SQL
info "database $DB_NAME, users dialforge@$APP_DBHOST + asterisk_rt@$RT_DBHOST (read-only, granted after the tables exist)"
fi

# ---------------------------------------------------------------- 4. app
if has app; then
say "4/9 VIZTEX app"
ENV_DB_HOST=localhost ENV_ARI_HOST=localhost ENV_AMI_HOST=127.0.0.1
[ "$SPLIT" = 1 ] && ENV_DB_HOST=$DB_IP ENV_ARI_HOST=$TEL_IP ENV_AMI_HOST=$TEL_IP
mkdir -p "$APP_DIR/certs"
# Code from the release; .env, certs, logs and node_modules stay.
cp -r "$RELEASE/app/." "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
# Written by the VIZTEX installer $(date -u +%F). Secrets also in $SECRETS (root only).
# A client's server: test-only tools (db:reset-test-data) refuse to run.
APP_ENV=production
DB_HOST=$ENV_DB_HOST
DB_USER=dialforge
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
ARI_HOST=$ENV_ARI_HOST
ARI_PORT=8088
ARI_USER=dialforge
ARI_PASS=$ARI_PASS
AMI_HOST=$ENV_AMI_HOST
AMI_PORT=5038
AMI_USER=dialforge
AMI_PASS=$AMI_PASS
SESSION_SECRET=$SESSION_SECRET
# The app on the standard https port (no :port in the address); old :3000 links redirect.
PORT=443
REDIRECT_FROM_PORT=3000
# The address of the app; agents' phones connect to SIP_DOMAIN (the telephony server).
APP_DOMAIN=$DOMAIN
SIP_DOMAIN=$TEL_DOMAIN
WEBRTC_WS_URL=wss://$TEL_DOMAIN:8089/ws
STUN_URLS=stun:$TEL_DOMAIN:3478,stun:stun.l.google.com:19302
TURN_URLS=turn:$TEL_DOMAIN:3478?transport=udp,turn:$TEL_DOMAIN:3478?transport=tcp$(if [ "$SPLIT" = 1 ]; then printf '\n# Recordings are made on the telephony server (S3 path: dialforge/<this>/recordings)\nRECORDINGS_HOST=%s' "$TEL_HOST"; fi)
TURN_SECRET=$TURN_SECRET
# The SIP trunk - set by install/add-trunk.sh
TRUNK_ENDPOINT=trunk
TRUNK_CALLER_ID=
DIALER_MAX_TRUNK_CHANNELS=4
REPORT_TIMEZONE=$TZ_NAME
APP_DISPLAY_NAME=$APP_NAME
ALERT_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ALERT_DAILY_HOUR=9
BACKUP_S3_BUCKET=
BACKUP_KEEP_DAYS=14
RECORDING_RETENTION_DAYS=90
STALE_AGENT_MINUTES=10
EOF
  umask 022
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
app_port
info "app port $APP_PORT ($APP_URL)"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund >> "$LOG" 2>&1 || die "npm ci"
sudo -u "$APP_USER" npm run -s db:migrate >> "$LOG" 2>&1 || die "database migrations"
# Asterisk's read-only user may read the 4 views it needs (they exist now).
RT_DBHOST=localhost; [ "$SPLIT" = 1 ] && RT_DBHOST=$TEL_IP
grants() {
  if [ "$SPLIT" = 1 ]; then MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_IP" -u dialforge "$DB_NAME"; else mysql; fi
}
grants <<SQL || die "asterisk_rt grants"
GRANT SELECT ON \`$DB_NAME\`.ps_endpoints TO 'asterisk_rt'@'$RT_DBHOST';
GRANT SELECT ON \`$DB_NAME\`.ps_auths TO 'asterisk_rt'@'$RT_DBHOST';
GRANT SELECT ON \`$DB_NAME\`.ps_aors TO 'asterisk_rt'@'$RT_DBHOST';
GRANT SELECT ON \`$DB_NAME\`.ast_queues TO 'asterisk_rt'@'$RT_DBHOST';
SQL
if ! is_done admin; then
  OUT=$(sudo -u "$APP_USER" npm run -s create-admin -- --username "$ADMIN" 2>&1) || die "create admin: $OUT"
  ADMIN_PASSWORD_LINE=$(printf '%s\n' "$OUT" | sed -n 's/^Password[^:]*: //p')
  done_step admin
fi
info "migrations applied; Super Admin '$ADMIN' ready"
fi

# ---------------------------------------------------------------- 5. Asterisk config
if has telephony; then
say "5/9 Asterisk configuration"
# Single server: ARI and AMI only on 127.0.0.1. Split: on the private IP, for the app server.
AST_BIND=127.0.0.1; [ "$SPLIT" = 1 ] && AST_BIND=$PRIVATE_IP
put /etc/asterisk/pjsip.conf root:asterisk 640 <<EOF
; Written by the VIZTEX installer. Agent extensions are NOT here - Asterisk
; reads them from MySQL (sorcery.conf / extconfig.conf). The SIP trunk is
; added by install/add-trunk.sh (below the marker line).
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0
external_media_address=$PUBLIC_IP
external_signaling_address=$PUBLIC_IP
local_net=$LOCAL_NET

[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
external_media_address=$PUBLIC_IP
external_signaling_address=$PUBLIC_IP
local_net=$LOCAL_NET

; ---- trunk (add-trunk.sh) ----
EOF
put /etc/asterisk/extensions.conf root:asterisk 640 <<'EOF'
; Written by the VIZTEX installer.
[general]
static=yes
writeprotect=yes

; Agents' browser phones. Calls are placed and bridged by the app (ARI).
[internal]
exten => 9000,1,NoOp(Entering ARI Stasis app)
 same => n,Stasis(dialforge-app)
 same => n,Hangup()
exten => _X.,1,NoOp(Extension to extension)
 same => n,Dial(PJSIP/${EXTEN},20)
 same => n,Hangup()

; Calls coming in from the SIP trunk: the app routes them by DID.
[from-trunk]
exten => _X.,1,NoOp(Inbound - CallerID ${CALLERID(num)}, dialed ${EXTEN})
 same => n,Stasis(dialforge-app,inbound,${CALLERID(num)},${EXTEN})
 same => n,Hangup()
exten => _+X.,1,Goto(from-trunk,${EXTEN:1},1)

; Hands a call to a real Asterisk queue (QUEUENAME set by the app).
[queue-dispatch]
exten => s,1,NoOp(Routing call to queue ${QUEUENAME})
 same => n,Queue(${QUEUENAME})
 same => n,Hangup()

#include extensions-dialer.conf
#include extensions-control.conf
#include extensions-monitor.conf
EOF
for f in extensions-dialer.conf extensions-control.conf extensions-monitor.conf; do
  install -o root -g asterisk -m 640 "$RELEASE/app/asterisk/$f" "/etc/asterisk/$f"
done
put /etc/asterisk/rtp.conf root:asterisk 640 <<EOF
[general]
rtpstart=10000
rtpend=20000

; AWS / NAT: tell browsers the public address, not the private one.
[ice_host_candidates]
$PRIVATE_IP => $PUBLIC_IP
EOF
put /etc/asterisk/http.conf root:asterisk 640 <<EOF
[general]
enabled=yes
enablestatic=no
bindaddr=$AST_BIND
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/dialforge.crt
tlsprivatekey=/etc/asterisk/keys/dialforge.key
EOF
put /etc/asterisk/ari.conf root:asterisk 640 <<EOF
[general]
enabled = yes

[dialforge]
type=user
read_only=no
password=$ARI_PASS
EOF
put /etc/asterisk/manager.conf root:asterisk 640 <<EOF
[general]
enabled = yes
port = 5038
bindaddr = $AST_BIND

[dialforge]
secret = $AMI_PASS
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255$(if [ "$SPLIT" = 1 ]; then printf '\npermit = %s/255.255.255.255' "$APP_IP"; fi)
read = system,call,agent,user,config
write = system,call,agent,user,config,originate
EOF
put /etc/asterisk/queues.conf root:asterisk 640 <<'EOF'
; Queues come from MySQL (ast_queues view); members are added by the app.
[general]
persistentmembers = yes
monitor-type = MixMonitor
EOF
put /etc/odbc.ini root:asterisk 640 <<EOF
[dialforge-asterisk]
Driver   = MariaDB Unicode
$(if [ "$SPLIT" = 1 ]; then printf 'SERVER   = %s\nPORT     = 3306' "$DB_IP"; else echo "SOCKET   = /var/run/mysqld/mysqld.sock"; fi)
DATABASE = $DB_NAME
EOF
put /etc/asterisk/res_odbc.conf root:asterisk 640 <<EOF
[dialforge]
enabled => yes
dsn => dialforge-asterisk
username => asterisk_rt
password => $ASTERISK_RT_PASSWORD
pre-connect => yes
max_connections => 5
EOF
put /etc/asterisk/extconfig.conf root:asterisk 640 <<'EOF'
[settings]
ps_endpoints => odbc,dialforge
ps_auths => odbc,dialforge
ps_aors => odbc,dialforge
queues => odbc,dialforge,ast_queues
EOF
put /etc/asterisk/sorcery.conf root:asterisk 640 <<'EOF'
; pjsip.conf first (transports, trunk), then MySQL (agent extensions).
[res_pjsip]
endpoint=config,pjsip.conf,criteria=type=endpoint
endpoint=realtime,ps_endpoints
auth=config,pjsip.conf,criteria=type=auth
auth=realtime,ps_auths
aor=config,pjsip.conf,criteria=type=aor
aor=realtime,ps_aors
EOF
put /etc/systemd/system/asterisk.service root:root 644 <<'EOF'
[Unit]
Description=Asterisk PBX
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
Environment=HOME=/var/lib/asterisk
WorkingDirectory=/var/lib/asterisk
User=asterisk
Group=asterisk
ExecStart=/usr/sbin/asterisk -mqf -C /etc/asterisk/asterisk.conf
ExecReload=/usr/sbin/asterisk -rx 'core reload'
RuntimeDirectory=asterisk
LimitCORE=infinity
LimitNOFILE=65536
Restart=always
RestartSec=4
StandardOutput=null
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
# The packaged init script, if 'make config' ran before, would fight the unit.
[ -f /etc/init.d/asterisk ] && update-rc.d -f asterisk remove >/dev/null 2>&1 || true
info "pjsip (transports, NAT $PRIVATE_IP -> $PUBLIC_IP), dialplan, ARI, AMI ($AST_BIND), ODBC realtime"
fi

# ---------------------------------------------------------------- 6. TURN
if has telephony; then
say "6/9 TURN server (coturn)"
put /etc/turnserver.conf root:turnserver 640 <<EOF
listening-port=3478
listening-ip=0.0.0.0
external-ip=$PUBLIC_IP/$PRIVATE_IP
relay-ip=$PRIVATE_IP
min-port=49152
max-port=49300
realm=$DOMAIN
use-auth-secret
static-auth-secret=$TURN_SECRET
fingerprint
no-cli
no-tls
no-dtls
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
log-file=/var/log/turnserver/turnserver.log
simple-log
EOF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
mkdir -p /var/log/turnserver && chown turnserver:turnserver /var/log/turnserver
systemctl enable coturn >> "$LOG" 2>&1
systemctl restart coturn || die "coturn didn't start"
fi

# ---------------------------------------------------------------- 7. certificate
if has telephony || has app; then
say "7/9 TLS certificate"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
put /usr/local/bin/viztex-cert-copy root:root 755 <<EOF
#!/bin/bash
# Copies the certificate where Asterisk and the app (non-root) can read it.
# Run by certbot after every renewal, and once by the installer.
set -e
SRC="\${1:-/etc/letsencrypt/live/$DOMAIN}"
# Asterisk (agents' phones, 8089) - on the server that has it.
if [ -d /etc/asterisk/keys ] && id asterisk >/dev/null 2>&1; then
  install -o asterisk -g asterisk -m 644 "\$SRC/fullchain.pem" /etc/asterisk/keys/dialforge.crt
  install -o asterisk -g asterisk -m 600 "\$SRC/privkey.pem" /etc/asterisk/keys/dialforge.key
  systemctl restart asterisk || true
fi
# The app (https) - on the server that has it.
if [ -d $APP_DIR/certs ]; then
  install -o $APP_USER -g $APP_USER -m 644 "\$SRC/fullchain.pem" $APP_DIR/certs/fullchain.pem
  install -o $APP_USER -g $APP_USER -m 600 "\$SRC/privkey.pem" $APP_DIR/certs/privkey.pem
  systemctl restart dialforge-backend 2>/dev/null || true
fi
EOF
ln -sf /usr/local/bin/viztex-cert-copy /etc/letsencrypt/renewal-hooks/deploy/viztex-cert-copy.sh
if [ "$SELF_SIGNED" = 1 ]; then
  SS=/etc/viztex/selfsigned
  if [ ! -f "$SS/privkey.pem" ]; then
    mkdir -p "$SS" && chmod 700 "$SS"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN,IP:$PUBLIC_IP" \
      -keyout "$SS/privkey.pem" -out "$SS/fullchain.pem" >> "$LOG" 2>&1
  fi
  /usr/local/bin/viztex-cert-copy "$SS" >> "$LOG" 2>&1
  warn "self-signed certificate: open $APP_URL and https://$DOMAIN:8089/ws once and accept the warning"
else
  if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN" >> "$LOG" 2>&1 ||
      die "Let's Encrypt certificate - is port 80 open to the internet and does $DOMAIN point here?"
  fi
  /usr/local/bin/viztex-cert-copy >> "$LOG" 2>&1
  info "Let's Encrypt certificate for $DOMAIN (renews by itself)"
fi
fi

# ---------------------------------------------------------------- 8. services
say "8/9 Services"
# On a single server the app waits for the local MySQL and Asterisk; split, they are elsewhere.
LOCAL_DEPS=""; [ "$SPLIT" = 0 ] && LOCAL_DEPS=" mysql.service asterisk.service"
if has app; then
put /etc/systemd/system/dialforge-backend.service root:root 644 <<EOF
[Unit]
Description=VIZTEX backend (web app, API, call control)
After=network.target$LOCAL_DEPS
Wants=${LOCAL_DEPS# }

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
# Port 443 without running as root: only this one extra right.
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=3
StandardOutput=append:$APP_DIR/server.log
StandardError=append:$APP_DIR/server.log

[Install]
WantedBy=multi-user.target
EOF
put /etc/systemd/system/dialforge-dialer.service root:root 644 <<EOF
[Unit]
Description=VIZTEX dialer engine (hopper + pacing)
After=network.target$LOCAL_DEPS
Wants=$([ "$SPLIT" = 0 ] && echo mysql.service)

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node dialer-engine.js
Restart=on-failure
RestartSec=5
StandardOutput=append:$APP_DIR/dialer.log
StandardError=append:$APP_DIR/dialer.log

[Install]
WantedBy=multi-user.target
EOF
# Nightly backup + recording conversion (backend/ops).
sed "s#/home/ubuntu#$APP_HOME#g; s#^User=ubuntu#User=$APP_USER#" "$APP_DIR/ops/dialforge-backup.service" > /etc/systemd/system/dialforge-backup.service
cp "$APP_DIR/ops/dialforge-backup.timer" /etc/systemd/system/
put /etc/logrotate.d/viztex root:root 644 <<EOF
$APP_DIR/server.log $APP_DIR/dialer.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
EOF
fi
# The recording script (MixMonitor runs it when a call's recording ends).
has telephony && install -o root -g root -m 755 "$RELEASE/app/ops/recording-done.sh" /usr/local/bin/dialforge-recording-done
systemctl daemon-reload
if has telephony; then
  systemctl enable asterisk >> "$LOG" 2>&1
  systemctl restart asterisk
  for i in $(seq 1 30); do /usr/sbin/asterisk -rx 'core show version' >/dev/null 2>&1 && break; sleep 1; done
fi
if has app; then
  systemctl enable dialforge-backend dialforge-dialer dialforge-backup.timer >> "$LOG" 2>&1
  systemctl restart dialforge-backend dialforge-dialer
  systemctl start dialforge-backup.timer
fi

# Split servers: the telephony and DB servers check themselves every minute and
# alert (the app server's own checks can't see their disk or services); the
# telephony server also backs up its config and recordings every night.
if [ "$SPLIT" = 1 ] && { has telephony || has db; }; then
  rm -rf /opt/viztex/ops && mkdir -p /opt/viztex && cp -r "$RELEASE/app/ops" /opt/viztex/ops
  chown -R root:root /opt/viztex && chmod 755 /opt/viztex/ops/*.sh
  if [ ! -f /etc/viztex/server.env ]; then
    put /etc/viztex/server.env "$APP_USER:$APP_USER" 600 <<EOF
# This server's part of a split VIZTEX (read by /opt/viztex/ops scripts).
SERVER_ROLE=$ROLE
SERVER_NAME=$([ "$ROLE" = db ] && echo "database $PRIVATE_IP" || echo "$DOMAIN")
APP_DISPLAY_NAME=$APP_NAME
# Alerts: the same bot / chat as the app server (its .env), see ops/README.md
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ALERT_WEBHOOK_URL=
# Telephony: off-server copy of config + recordings (the bucket the app uses)
BACKUP_S3_BUCKET=
BACKUP_KEEP_DAYS=14
RECORDING_RETENTION_DAYS=90
EOF
  fi
  put /etc/systemd/system/viztex-server-health.service root:root 644 <<'EOF'
[Unit]
Description=VIZTEX server health check (split servers)

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/viztex/ops/server-health.sh
EOF
  put /etc/systemd/system/viztex-server-health.timer root:root 644 <<'EOF'
[Unit]
Description=VIZTEX server health check every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
EOF
  if has telephony; then
    put /etc/systemd/system/dialforge-backup.service root:root 644 <<EOF
[Unit]
Description=VIZTEX nightly backup of the telephony server (Asterisk config, recordings)

[Service]
Type=oneshot
User=$APP_USER
Environment=BACKUP_ENV=/etc/viztex/server.env APP_DIR=/opt/viztex
ExecStart=/bin/bash /opt/viztex/ops/backup.sh
Nice=10
IOSchedulingClass=idle
EOF
    cp "$RELEASE/app/ops/dialforge-backup.timer" /etc/systemd/system/
  fi
  systemctl daemon-reload
  systemctl enable --now viztex-server-health.timer >> "$LOG" 2>&1
  has telephony && systemctl enable --now dialforge-backup.timer >> "$LOG" 2>&1
  info "server health check every minute$(has telephony && echo ', nightly backup'); alerts: /etc/viztex/server.env"
fi

if [ "$FIREWALL" = 1 ]; then
  ufw allow 22/tcp >/dev/null
  has app && { ufw allow 443/tcp >/dev/null; ufw allow 3000/tcp >/dev/null; }
  { has app || has telephony; } && ufw allow 80/tcp >/dev/null
  if has telephony; then
    ufw allow 8089/tcp >/dev/null; ufw allow 3478 >/dev/null; ufw allow 10000:20000/udp >/dev/null
    ufw allow 49152:49300/udp >/dev/null
    [ "$SPLIT" = 1 ] && { ufw allow from "$APP_IP" to any port 8088 proto tcp >/dev/null; ufw allow from "$APP_IP" to any port 5038 proto tcp >/dev/null; }
  fi
  [ "$ROLE" = db ] && { ufw allow from "$APP_IP" to any port 3306 proto tcp >/dev/null; ufw allow from "$TEL_IP" to any port 3306 proto tcp >/dev/null; }
  ufw --force enable >/dev/null
  info "ufw: on, ports for role $ROLE open"
fi
fi # --checks-only skips everything above

# ---------------------------------------------------------------- 9. checks
say "9/9 Checks"
FAILS=0
check() { # check <label> <command...>
  if "${@:2}" >> "$LOG" 2>&1; then info "OK    $1"; else warn "FAIL  $1"; FAILS=$((FAILS + 1)); fi
}
ast() { /usr/sbin/asterisk -rx "$1" 2>/dev/null; }
sleep 4
if has telephony; then
check "Asterisk running" systemctl is-active --quiet asterisk
check "Asterisk HTTPS / WebSocket on 8089" bash -c "/usr/sbin/asterisk -rx 'http show status' | grep -q 'HTTPS Server Enabled'"
check "Asterisk reads MySQL (ODBC)$(if [ "$SPLIT" = 1 ]; then echo ' - on split servers only after the app install: then --checks-only'; fi)" bash -c "/usr/sbin/asterisk -rx 'odbc show dialforge' | grep -qiE 'active connections: [1-9]|connected: yes'"
check "Asterisk modules: AMD, MixMonitor, realtime" bash -c "for m in app_amd app_mixmonitor res_config_odbc; do /usr/sbin/asterisk -rx \"module show like \$m\" | grep -q Running || exit 1; done"
check "TURN server" systemctl is-active --quiet coturn
[ "$SELF_SIGNED" = 1 ] || [ "$ROLE" != telephony ] || check "Certificate valid for $DOMAIN (agents' phones, 8089)" bash -c "echo | openssl s_client -connect localhost:8089 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -checkhost $DOMAIN | grep -q 'does match'"
fi
if has db; then
check "MySQL" systemctl is-active --quiet mysql
fi
if [ "$SPLIT" = 1 ] && { has telephony || has db; }; then
check "Server health check every minute (alerts: /etc/viztex/server.env)" systemctl is-enabled --quiet viztex-server-health.timer
has telephony && check "Nightly backup scheduled (config + recordings)" systemctl is-enabled --quiet dialforge-backup.timer
fi
if [ "$SPLIT" = 0 ]; then
check "MySQL and Asterisk HTTP (ARI) only on 127.0.0.1" bash -c "! ss -lntH | awk '{print \$4}' | grep -qE '^(\*|0\.0\.0\.0|\[::\]):(3306|33060|8088)\$'"
else
check "MySQL, ARI and AMI not open on every address (private IP only)" bash -c "! ss -lntH | awk '{print \$4}' | grep -qE '^(\*|0\.0\.0\.0|\[::\]):(3306|33060|8088|5038)\$'"
fi
if has app; then
[ -n "${APP_PORT:-}" ] || app_port
check "Licence readable by the app (if one is set)" bash -c "[ ! -f /etc/viztex/licence.json ] || sudo -u $APP_USER cat /etc/viztex/licence.json >/dev/null"
for i in $(seq 1 20); do curl -sk https://localhost:$APP_PORT/health | grep -q '"ok"' && break; sleep 1; done
check "VIZTEX backend /health (database$(if [ "$SPLIT" = 1 ]; then echo " on $DB_IP"; fi) connected)" bash -c "curl -sk https://localhost:$APP_PORT/health | grep -q '\"db\":\"connected\"'"
[ "$APP_PORT" = 3000 ] || check "Old :3000 links redirect to $APP_URL" bash -c "curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' https://localhost:3000/app/ | grep -q '^301 $APP_URL/app/'"
check "Backend connected to Asterisk (ARI)$(if [ "$SPLIT" = 1 ]; then echo " on $TEL_IP"; fi)" bash -c "grep -q 'app \"dialforge-app\" connected' '$APP_DIR/server.log'"
check "Dialer engine running" bash -c "grep -q 'dialer engine started' '$APP_DIR/dialer.log'"
check "Nightly backup scheduled" systemctl is-enabled --quiet dialforge-backup.timer
[ "$SELF_SIGNED" = 1 ] || check "Certificate valid for $DOMAIN" bash -c "echo | openssl s_client -connect localhost:$APP_PORT -servername $DOMAIN 2>/dev/null | openssl x509 -noout -checkhost $DOMAIN | grep -q 'does match'"
fi

if [ "$ROLE" = db ] || [ "$ROLE" = telephony ]; then
  cat <<EOF | tee -a "$LOG"

==========================================================================
 VIZTEX $ROLE server installed ($([ "$FAILS" = 0 ] && echo "all checks OK" || echo "$FAILS check(s) FAILED - see $LOG"))
EOF
  if [ "$ROLE" = db ]; then
    cat <<EOF

 Next: copy this server's secrets to the telephony and app servers
 (they are passwords - copy them over SSH, never by email or chat):
   sudo cat /etc/viztex/secrets.env      -> save as ~/secrets.env on each of them,
   then pass --secrets ~/secrets.env to their install (delete the copy afterwards).
 Security group: TCP 3306 only from $APP_IP and $TEL_IP. Nothing else open but SSH.
==========================================================================
EOF
  else
    cat <<EOF

 Security group (telephony): TCP 8089, 80, 3478; UDP 3478, 10000-20000, 49152-49300
   from anywhere; TCP 8088 + 5038 only from the app server ($APP_IP); UDP 5060 only
   from the SIP provider.
 Next: install the app server. Then here: sudo bash $0 --role telephony ... --checks-only
==========================================================================
EOF
  fi
  [ "$FAILS" = 0 ]
  exit
fi
cat <<EOF | tee -a "$LOG"

==========================================================================
 VIZTEX is installed on $DOMAIN  ($([ "$FAILS" = 0 ] && echo "all checks OK" || echo "$FAILS check(s) FAILED - see $LOG"))

 Open:        $APP_URL
 Super Admin: $ADMIN
EOF
if [ -n "$ADMIN_PASSWORD_LINE" ]; then
  echo " Password:    $ADMIN_PASSWORD_LINE   (shown once - change it after logging in)"
else
  echo " Password:    (set on the first run - reset with: cd $APP_DIR && npm run create-admin -- --username <new>)"
fi
cat <<EOF

 Open these ports to the internet (AWS: the security group):
   TCP $APP_PORT (app)$([ "$APP_PORT" = 3000 ] || echo ", 3000 (old links)"), 8089 (agents' phones), 80 (certificate renewal), 3478 (TURN)
   UDP 3478, 10000-20000 (call audio), 49152-49300 (TURN relay)
   SSH 22 from your office IP only. Never open 3306 (MySQL) or 5038 (AMI).

 Next:
   1. The client's licence, then their agent seats (extensions) - only here on the server:
        sudo bash $(dirname "$0")/set-licence.sh --customer "<name>" --seats 10 --channels 15 --expires <YYYY-MM-DD>
        cd $APP_DIR && npm run ext:add -- --from 1001 --count 10
      Then log in: Users -> add agents (each with an extension), Teams, Queues, Campaigns.
   2. The client's SIP trunk:  sudo bash $(dirname "$0")/add-trunk.sh --help
   3. Alerts / off-server backups: ALERT_WEBHOOK_URL, BACKUP_S3_BUCKET in $ENV_FILE
      (then: sudo systemctl restart dialforge-backend) - see $APP_DIR/ops/README.md
==========================================================================
EOF
[ "$FAILS" = 0 ]
