#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/fiar-phase6-smoke.XXXXXX")
PROJECT="fiar_phase6_smoke_$$_$(date +%s)"
COMPOSE="docker compose --project-name $PROJECT --env-file $TEMP/smoke.env -f $ROOT/infra/compose/docker-compose.yml -f $ROOT/infra/compose/docker-compose.production-smoke.yml"
FAILED=1

cleanup() {
  if [ "$FAILED" -ne 0 ]; then $COMPOSE ps || true; $COMPOSE logs --no-color --tail=200 || true; fi
  $COMPOSE down --volumes --remove-orphans >/dev/null 2>&1 || true
  case "$TEMP" in "${TMPDIR:-/tmp}"/fiar-phase6-smoke.*) rm -rf "$TEMP" ;; *) echo "Refusing unsafe temporary cleanup" >&2 ;; esac
}
trap cleanup EXIT INT TERM

for name in postgres_password credential_pepper session_pepper csrf_key oidc_state_key oidc_client_secret metrics_token; do
  openssl rand -hex 32 > "$TEMP/$name"
  chmod 400 "$TEMP/$name"
done
POSTGRES_PASSWORD=$(tr -d '\n' < "$TEMP/postgres_password")
printf 'postgresql://fiar:%s@postgres:5432/fiar\n' "$POSTGRES_PASSWORD" > "$TEMP/database_url"
chmod 400 "$TEMP/database_url"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TEMP/key.pem" -out "$TEMP/cert.pem" -days 1 -subj '/CN=fake-oidc' -addext 'subjectAltName=DNS:fake-oidc' >/dev/null 2>&1
chmod 400 "$TEMP/key.pem" "$TEMP/cert.pem"

cat > "$TEMP/smoke.env" <<EOF
FIAR_POSTGRES_PASSWORD_FILE=$TEMP/postgres_password
FIAR_DATABASE_URL_FILE=$TEMP/database_url
FIAR_CREDENTIAL_PEPPER_FILE=$TEMP/credential_pepper
FIAR_SESSION_PEPPER_FILE=$TEMP/session_pepper
FIAR_CSRF_KEY_FILE=$TEMP/csrf_key
FIAR_OIDC_STATE_KEY_FILE=$TEMP/oidc_state_key
FIAR_OIDC_CLIENT_SECRET_FILE=$TEMP/oidc_client_secret
FIAR_METRICS_TOKEN_FILE=$TEMP/metrics_token
FIAR_SMOKE_TLS_DIR=$TEMP
FIAR_DASHBOARD_PORT=48080
EOF

$COMPOSE config --quiet
$COMPOSE build gateway worker dashboard fake-oidc
$COMPOSE up -d postgres migrate fake-oidc
$COMPOSE wait migrate >/dev/null
$COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 -U fiar -d fiar < "$ROOT/db/seeds/local-dev.sql" >/dev/null
TOKEN=$($COMPOSE run --rm --no-deps gateway node dist/gateway/admin-cli.js credential-create --tenant ten_demo_alpha --principal prn_demo_alpha_agent --expires-days 1)
case "$TOKEN" in fiar_wcr_*) ;; *) echo "Credential creation did not return a workload token" >&2; exit 1 ;; esac
$COMPOSE up -d --wait gateway worker dashboard

test "$(docker inspect --format '{{.Config.User}}' "$($COMPOSE ps -q gateway)")" = node
test "$(docker inspect --format '{{.Config.User}}' "$($COMPOSE ps -q worker)")" = node
test "$(docker inspect --format '{{.Config.User}}' "$($COMPOSE ps -q dashboard)")" = nginx

STATUS=$(curl -sS -o "$TEMP/dev-response" -w '%{http_code}' -H 'x-fiar-dev-credential: alpha-agent' http://127.0.0.1:48080/v1/actions)
test "$STATUS" = 401
STATUS=$(curl -sS -o "$TEMP/action-response" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"tool":"refund.create","orderId":"ord_demo_small","amountMinor":4900,"currency":"USD","idempotencyKey":"production-smoke"}' http://127.0.0.1:48080/v1/actions)
test "$STATUS" = 201

for attempt in $(seq 1 30); do
  ACTION_STATUS=$($COMPOSE exec -T postgres psql -U fiar -d fiar -Atc "select status from actions where idempotency_key = 'production-smoke'")
  [ "$ACTION_STATUS" = completed ] && break
  sleep 1
done
test "$ACTION_STATUS" = completed
$COMPOSE exec -T gateway node -e "fetch('http://127.0.0.1:3000/health/ready').then(async r=>{if(!r.ok)throw Error(await r.text())})"
$COMPOSE exec -T worker node -e "fetch('http://127.0.0.1:3001/health/ready').then(async r=>{if(!r.ok)throw Error(await r.text())})"
METRICS_TOKEN=$(tr -d '\n' < "$TEMP/metrics_token")
$COMPOSE exec -T gateway node -e "fetch('http://127.0.0.1:3000/metrics',{headers:{authorization:'Bearer $METRICS_TOKEN'}}).then(async r=>{const b=await r.text();if(!r.ok||!b.includes('fiar_readiness'))throw Error('gateway metrics failed')})"
$COMPOSE exec -T worker node -e "fetch('http://127.0.0.1:3001/metrics',{headers:{authorization:'Bearer $METRICS_TOKEN'}}).then(async r=>{const b=await r.text();if(!r.ok||!b.includes('fiar_worker_claims_total'))throw Error('worker metrics failed')})"
$COMPOSE exec -T postgres psql -U fiar -d fiar -Atc "select count(*) from fake_provider_refunds where status = 'succeeded'" | grep -Eq '^[1-9][0-9]*$'

FAILED=0
echo "Production-mode container smoke passed"
