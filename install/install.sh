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
#
# Safe to run again: finished steps are skipped, secrets are kept
# (/etc/viztex/secrets.env), existing configs are backed up before changes.
set -euo pipefail

# ---------------------------------------------------------------- options
DOMAIN="" ADMIN="" EMAIL="" TZ_NAME="Asia/Kolkata" APP_NAME="VIZTEX"
SELF_SIGNED=0 PUBLIC_IP="" FIREWALL=0 SKIP_AST_BUILD=0
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
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

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
chmod 700 /etc/viztex
: >> "$LOG"; chmod 600 "$LOG"

[ -n "$DOMAIN" ] || die "--domain is required (the hostname agents will open)"
[ -n "$ADMIN" ] || die "--admin is required (the first Super Admin's username)"
[ "$SELF_SIGNED" = 1 ] || [ -n "$EMAIL" ] || die "--email is required for the Let's Encrypt certificate (or use --self-signed to test)"
[[ "$ADMIN" =~ ^[A-Za-z0-9._-]{3,50}$ ]] || die "--admin: 3-50 letters, digits, dots, dashes or underscores"
[ -d "$RELEASE/app" ] || die "app/ not found next to install/ - unpack the whole release package"
. /etc/os-release
[ "$ID" = ubuntu ] && [ "${VERSION_ID%%.*}" -ge 24 ] || die "needs Ubuntu 24.04 (this is $PRETTY_NAME)"

say "VIZTEX install $(cat "$RELEASE/VERSION" 2>/dev/null || echo '?') - $DOMAIN"
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
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "couldn't find the public IP - pass --public-ip"
info "public IP $PUBLIC_IP   private IP $PRIVATE_IP   local net $LOCAL_NET"

DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
if [ "$DNS_IP" != "$PUBLIC_IP" ]; then
  if [ "$SELF_SIGNED" = 1 ]; then
    warn "$DOMAIN resolves to '${DNS_IP:-nothing}', not $PUBLIC_IP - fine for a self-signed test"
  else
    die "$DOMAIN resolves to '${DNS_IP:-nothing}', not this server ($PUBLIC_IP). Point the DNS record here first (the certificate needs it)."
  fi
fi

# Secrets: made once, kept across re-runs.
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
. "$SECRETS"

# ---------------------------------------------------------------- 1. packages
if ! is_done packages; then
  say "1/9 System packages"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  timedatectl set-timezone UTC 2>/dev/null || true # the app stores UTC; reports use --timezone
  apt-get update -y >> "$LOG" 2>&1
  apt-get upgrade -y >> "$LOG" 2>&1
  apt-get install -y build-essential git wget curl subversion libncurses5-dev libssl-dev libxml2-dev \
    libsqlite3-dev uuid-dev libjansson-dev pkg-config libedit-dev automake libtool python3 unzip \
    libsrtp2-dev unixodbc unixodbc-dev odbc-mariadb mysql-server coturn certbot ffmpeg openssl \
    ca-certificates gnupg >> "$LOG" 2>&1 || die "apt-get install"
  if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
    curl -fsSL "https://deb.nodesource.com/setup_$NODE_MAJOR.x" | bash - >> "$LOG" 2>&1 || die "Node.js repository"
    apt-get install -y nodejs >> "$LOG" 2>&1 || die "Node.js"
  fi
  info "node $(node -v), mysql $(mysql --version | awk '{print $3}')"
  done_step packages
fi

# ---------------------------------------------------------------- 2. Asterisk
if [ "$SKIP_AST_BUILD" = 0 ] && ! is_done asterisk-build; then
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
/usr/sbin/asterisk -V >/dev/null 2>&1 || die "Asterisk is not installed"
id asterisk >/dev/null 2>&1 || useradd -r -d /var/lib/asterisk -s /usr/sbin/nologin asterisk
mkdir -p /etc/asterisk/keys /var/spool/asterisk/monitor/dialforge
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /usr/lib/asterisk
chmod 2775 /var/spool/asterisk/monitor/dialforge

# ---------------------------------------------------------------- 3. MySQL
say "3/9 Database"
systemctl enable --now mysql >> "$LOG" 2>&1
mysql <<SQL || die "create database / users"
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'dialforge'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER 'dialforge'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO 'dialforge'@'localhost';
CREATE USER IF NOT EXISTS 'asterisk_rt'@'localhost' IDENTIFIED BY '$ASTERISK_RT_PASSWORD';
ALTER USER 'asterisk_rt'@'localhost' IDENTIFIED BY '$ASTERISK_RT_PASSWORD';
FLUSH PRIVILEGES;
SQL
info "database $DB_NAME, users dialforge + asterisk_rt (read-only, granted after the tables exist)"

# ---------------------------------------------------------------- 4. app
say "4/9 VIZTEX app"
mkdir -p "$APP_DIR/certs"
# Code from the release; .env, certs, logs and node_modules stay.
cp -r "$RELEASE/app/." "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
# Written by the VIZTEX installer $(date -u +%F). Secrets also in $SECRETS (root only).
# A client's server: test-only tools (db:reset-test-data) refuse to run.
APP_ENV=production
DB_HOST=localhost
DB_USER=dialforge
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
ARI_HOST=localhost
ARI_PORT=8088
ARI_USER=dialforge
ARI_PASS=$ARI_PASS
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USER=dialforge
AMI_PASS=$AMI_PASS
SESSION_SECRET=$SESSION_SECRET
PORT=3000
SIP_DOMAIN=$DOMAIN
WEBRTC_WS_URL=wss://$DOMAIN:8089/ws
STUN_URLS=stun:$DOMAIN:3478,stun:stun.l.google.com:19302
TURN_URLS=turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
TURN_SECRET=$TURN_SECRET
# The SIP trunk - set by install/add-trunk.sh
TRUNK_ENDPOINT=trunk
TRUNK_CALLER_ID=
DIALER_MAX_TRUNK_CHANNELS=4
REPORT_TIMEZONE=$TZ_NAME
APP_DISPLAY_NAME=$APP_NAME
ALERT_WEBHOOK_URL=
BACKUP_S3_BUCKET=
BACKUP_KEEP_DAYS=14
RECORDING_RETENTION_DAYS=90
STALE_AGENT_MINUTES=10
EOF
  umask 022
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund >> "$LOG" 2>&1 || die "npm ci"
sudo -u "$APP_USER" npm run -s db:migrate >> "$LOG" 2>&1 || die "database migrations"
mysql <<SQL || die "asterisk_rt grants"
GRANT SELECT ON \`$DB_NAME\`.ps_endpoints TO 'asterisk_rt'@'localhost';
GRANT SELECT ON \`$DB_NAME\`.ps_auths TO 'asterisk_rt'@'localhost';
GRANT SELECT ON \`$DB_NAME\`.ps_aors TO 'asterisk_rt'@'localhost';
GRANT SELECT ON \`$DB_NAME\`.ast_queues TO 'asterisk_rt'@'localhost';
SQL
ADMIN_PASSWORD_LINE=""
if ! is_done admin; then
  OUT=$(sudo -u "$APP_USER" npm run -s create-admin -- --username "$ADMIN" 2>&1) || die "create admin: $OUT"
  ADMIN_PASSWORD_LINE=$(printf '%s\n' "$OUT" | sed -n 's/^Password[^:]*: //p')
  done_step admin
fi
info "migrations applied; Super Admin '$ADMIN' ready"

# ---------------------------------------------------------------- 5. Asterisk config
say "5/9 Asterisk configuration"
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
put /etc/asterisk/http.conf root:asterisk 640 <<'EOF'
[general]
enabled=yes
enablestatic=no
bindaddr=0.0.0.0
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
bindaddr = 127.0.0.1

[dialforge]
secret = $AMI_PASS
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
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
SOCKET   = /var/run/mysqld/mysqld.sock
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
info "pjsip (transports, NAT $PRIVATE_IP -> $PUBLIC_IP), dialplan, ARI, AMI, ODBC realtime"

# ---------------------------------------------------------------- 6. TURN
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

# ---------------------------------------------------------------- 7. certificate
say "7/9 TLS certificate"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
put /usr/local/bin/viztex-cert-copy root:root 755 <<EOF
#!/bin/bash
# Copies the certificate where Asterisk and the app (non-root) can read it.
# Run by certbot after every renewal, and once by the installer.
set -e
SRC="\${1:-/etc/letsencrypt/live/$DOMAIN}"
install -o asterisk -g asterisk -m 644 "\$SRC/fullchain.pem" /etc/asterisk/keys/dialforge.crt
install -o asterisk -g asterisk -m 600 "\$SRC/privkey.pem" /etc/asterisk/keys/dialforge.key
install -o $APP_USER -g $APP_USER -m 644 "\$SRC/fullchain.pem" $APP_DIR/certs/fullchain.pem
install -o $APP_USER -g $APP_USER -m 600 "\$SRC/privkey.pem" $APP_DIR/certs/privkey.pem
systemctl restart asterisk || true
systemctl restart dialforge-backend 2>/dev/null || true
EOF
ln -sf /usr/local/bin/viztex-cert-copy /etc/letsencrypt/renewal-hooks/deploy/viztex-cert-copy.sh
if [ "$SELF_SIGNED" = 1 ]; then
  SS=/etc/viztex/selfsigned
  if [ ! -f "$SS/privkey.pem" ]; then
    mkdir -p "$SS"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN,IP:$PUBLIC_IP" \
      -keyout "$SS/privkey.pem" -out "$SS/fullchain.pem" >> "$LOG" 2>&1
  fi
  /usr/local/bin/viztex-cert-copy "$SS" >> "$LOG" 2>&1
  warn "self-signed certificate: open https://$DOMAIN:3000 and https://$DOMAIN:8089/ws once and accept the warning"
else
  if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN" >> "$LOG" 2>&1 ||
      die "Let's Encrypt certificate - is port 80 open to the internet and does $DOMAIN point here?"
  fi
  /usr/local/bin/viztex-cert-copy >> "$LOG" 2>&1
  info "Let's Encrypt certificate for $DOMAIN (renews by itself)"
fi

# ---------------------------------------------------------------- 8. services
say "8/9 Services"
put /etc/systemd/system/dialforge-backend.service root:root 644 <<EOF
[Unit]
Description=VIZTEX backend (web app, API, call control)
After=network.target mysql.service asterisk.service
Wants=mysql.service asterisk.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
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
After=network.target mysql.service asterisk.service
Wants=mysql.service

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
install -o root -g root -m 755 "$APP_DIR/ops/recording-done.sh" /usr/local/bin/dialforge-recording-done
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
systemctl daemon-reload
systemctl enable asterisk dialforge-backend dialforge-dialer dialforge-backup.timer >> "$LOG" 2>&1
systemctl restart asterisk
for i in $(seq 1 30); do /usr/sbin/asterisk -rx 'core show version' >/dev/null 2>&1 && break; sleep 1; done
systemctl restart dialforge-backend dialforge-dialer
systemctl start dialforge-backup.timer

if [ "$FIREWALL" = 1 ]; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 3000/tcp >/dev/null
  ufw allow 8089/tcp >/dev/null; ufw allow 3478 >/dev/null; ufw allow 10000:20000/udp >/dev/null
  ufw allow 49152:49300/udp >/dev/null; ufw --force enable >/dev/null
  info "ufw: 22, 80, 3000, 8089, 3478, 10000-20000/udp, 49152-49300/udp open"
fi

# ---------------------------------------------------------------- 9. checks
say "9/9 Checks"
FAILS=0
check() { # check <label> <command...>
  if "${@:2}" >> "$LOG" 2>&1; then info "OK    $1"; else warn "FAIL  $1"; FAILS=$((FAILS + 1)); fi
}
ast() { /usr/sbin/asterisk -rx "$1" 2>/dev/null; }
sleep 4
check "Asterisk running" systemctl is-active --quiet asterisk
check "Asterisk HTTPS / WebSocket on 8089" bash -c "/usr/sbin/asterisk -rx 'http show status' | grep -q 'HTTPS Server Enabled'"
check "Asterisk reads MySQL (ODBC)" bash -c "/usr/sbin/asterisk -rx 'odbc show dialforge' | grep -qi 'connected: yes'"
check "Asterisk modules: AMD, MixMonitor, realtime" bash -c "for m in app_amd app_mixmonitor res_config_odbc; do /usr/sbin/asterisk -rx \"module show like \$m\" | grep -q Running || exit 1; done"
check "TURN server" systemctl is-active --quiet coturn
check "MySQL" systemctl is-active --quiet mysql
for i in $(seq 1 20); do curl -sk https://localhost:3000/health | grep -q '"ok"' && break; sleep 1; done
check "VIZTEX backend /health" bash -c "curl -sk https://localhost:3000/health | grep -q '\"db\":\"connected\"'"
check "Backend connected to Asterisk (ARI)" bash -c "grep -q 'app \"dialforge-app\" connected' '$APP_DIR/server.log'"
check "Dialer engine running" bash -c "grep -q 'dialer engine started' '$APP_DIR/dialer.log'"
check "Nightly backup scheduled" systemctl is-enabled --quiet dialforge-backup.timer
[ "$SELF_SIGNED" = 1 ] || check "Certificate valid for $DOMAIN" bash -c "echo | openssl s_client -connect localhost:3000 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -checkhost $DOMAIN | grep -q 'does match'"

cat <<EOF | tee -a "$LOG"

==========================================================================
 VIZTEX is installed on $DOMAIN  ($([ "$FAILS" = 0 ] && echo "all checks OK" || echo "$FAILS check(s) FAILED - see $LOG"))

 Open:        https://$DOMAIN:3000
 Super Admin: $ADMIN
EOF
if [ -n "$ADMIN_PASSWORD_LINE" ]; then
  echo " Password:    $ADMIN_PASSWORD_LINE   (shown once - change it after logging in)"
else
  echo " Password:    (set on the first run - reset with: cd $APP_DIR && npm run create-admin -- --username <new>)"
fi
cat <<EOF

 Open these ports to the internet (AWS: the security group):
   TCP 3000 (app), 8089 (agents' phones), 80 (certificate renewal), 3478 (TURN)
   UDP 3478, 10000-20000 (call audio), 49152-49300 (TURN relay)
   SSH 22 from your office IP only. Never open 3306 (MySQL) or 5038 (AMI).

 Next:
   1. The client's agent seats (extensions) - only here on the server, the app can't add them:
        cd $APP_DIR && npm run ext:add -- --from 1001 --count 10
      Then log in: Users -> add agents (each with an extension), Teams, Queues, Campaigns.
   2. The client's SIP trunk:  sudo bash $(dirname "$0")/add-trunk.sh --help
   3. Alerts / off-server backups: ALERT_WEBHOOK_URL, BACKUP_S3_BUCKET in $ENV_FILE
      (then: sudo systemctl restart dialforge-backend) - see $APP_DIR/ops/README.md
==========================================================================
EOF
[ "$FAILS" = 0 ]
