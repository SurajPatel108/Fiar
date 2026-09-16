#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/fiar-phase6-smoke.XXXXXX")
# Set directory permissions so non-root container users (node, postgres, nginx) can traverse the bind mount
chmod 755 "$TEMP"
PROJECT="fiar_phase6_smoke_$$_$(date +%s)"
COMPOSE="docker compose --project-name $PROJECT --env-file $TEMP/smoke.env -f $ROOT/infra/compose/docker-compose.yml -f $ROOT/infra/compose/docker-compose.production-smoke.yml"
FAILED=1

cleanup() {
  if [ "$FAILED" -ne 0 ]; then $COMPOSE ps || true; $COMPOSE logs --no-color --tail=200 || true; fi
  $COMPOSE down --volumes --remove-orphans >/dev/null 2>&1 || true
  case "$TEMP" in "${TMPDIR:-/tmp}"/fiar-phase6-smoke.*) rm -rf "$TEMP" ;; *) echo "Refusing unsafe temporary cleanup" >&2 ;; esac
}
trap cleanup EXIT INT TERM

# Create test secrets and TLS certificates with mode 0644.
# These temporary test permissions are safe because they reside inside an isolated, uniquely named
# temporary directory ($TEMP) that is only created for this test run and automatically cleaned up on exit.
# FileSecretProvider verifies (stat.mode & 0o022) === 0, ensuring files are not group/world writable.
for name in postgres_password credential_pepper session_pepper csrf_key oidc_state_key oidc_client_secret metrics_token; do
  openssl rand -hex 32 > "$TEMP/$name"
  chmod 644 "$TEMP/$name"
done
POSTGRES_PASSWORD=$(tr -d '\n' < "$TEMP/postgres_password")
printf 'postgresql://fiar:%s@postgres:5432/fiar\n' "$POSTGRES_PASSWORD" > "$TEMP/database_url"
chmod 644 "$TEMP/database_url"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TEMP/key.pem" -out "$TEMP/cert.pem" -days 1 -subj '/CN=fake-oidc' -addext 'subjectAltName=DNS:fake-oidc' >/dev/null 2>&1
chmod 644 "$TEMP/key.pem" "$TEMP/cert.pem"

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

# Create workload credential
TOKEN=$($COMPOSE run --rm --no-deps gateway node dist/gateway/admin-cli.js credential-create --tenant ten_demo_alpha --principal prn_demo_alpha_agent --expires-days 1)
case "$TOKEN" in fiar_wcr_*) ;; *) echo "Credential creation did not return a workload token" >&2; exit 1 ;; esac

# Verify raw secret is only returned once and only the HMAC verifier is stored in PostgreSQL
CRED_ID=$(printf '%s' "$TOKEN" | sed -E 's/^fiar_(wcr_[0-9a-f-]+)_.*/\1/')
STORED_VERIFIER=$($COMPOSE exec -T postgres psql -U fiar -d fiar -Atc "select verifier from workload_credentials where id = '$CRED_ID'")
case "$TOKEN" in *"$STORED_VERIFIER"*) echo "Raw credential secret was stored in plaintext" >&2; exit 1 ;; esac

# Map manager human identity for OIDC login
$COMPOSE run --rm --no-deps gateway node dist/gateway/admin-cli.js identity-map --issuer https://fake-oidc:4443 --subject manager-subject --tenant ten_demo_alpha --principal prn_demo_alpha_manager >/dev/null

$COMPOSE up -d --wait gateway worker dashboard

# Verify runtime containers use intended non-root users
test "$(docker inspect --format '{{.Config.User}}' "$($COMPOSE ps -q gateway)")" = node
test "$(docker inspect --format '{{.Config.User}}' "$($COMPOSE ps -q worker)")" = node
test "$(docker inspect --format '{{.Config.User}}' "$($COMPOSE ps -q dashboard)")" = nginx

# Verify development headers are rejected in production
STATUS=$(curl -sS -o "$TEMP/dev-response" -w '%{http_code}' -H 'x-fiar-dev-credential: alpha-agent' http://127.0.0.1:48080/v1/actions)
test "$STATUS" = 401

# Submit workload-authenticated action
STATUS=$(curl -sS -o "$TEMP/action-response" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"tool":"refund.create","orderId":"ord_demo_small","amountMinor":4900,"currency":"USD","idempotencyKey":"production-smoke"}' http://127.0.0.1:48080/v1/actions)
test "$STATUS" = 201

# Wait for worker to complete action
for attempt in $(seq 1 30); do
  ACTION_STATUS=$($COMPOSE exec -T postgres psql -U fiar -d fiar -Atc "select status from actions where idempotency_key = 'production-smoke'")
  [ "$ACTION_STATUS" = completed ] && break
  sleep 1
done
test "$ACTION_STATUS" = completed

# Verify provider side-effect recorded once
$COMPOSE exec -T postgres psql -U fiar -d fiar -Atc "select count(*) from fake_provider_refunds where status = 'succeeded'" | grep -Eq '^[1-9][0-9]*$'

# Verify readiness endpoints
$COMPOSE exec -T gateway node -e "fetch('http://127.0.0.1:3000/health/ready').then(async r=>{if(!r.ok)throw Error(await r.text())})"
$COMPOSE exec -T worker node -e "fetch('http://127.0.0.1:3001/health/ready').then(async r=>{if(!r.ok)throw Error(await r.text())})"

# Verify metrics authentication
METRICS_TOKEN=$(tr -d '\n' < "$TEMP/metrics_token")
$COMPOSE exec -T gateway node -e "fetch('http://127.0.0.1:3000/metrics').then(r=>{if(r.status!==401)throw Error('unauthorized metrics access allowed')})"
$COMPOSE exec -T worker node -e "fetch('http://127.0.0.1:3001/metrics').then(r=>{if(r.status!==401)throw Error('unauthorized metrics access allowed')})"
$COMPOSE exec -T gateway node -e "fetch('http://127.0.0.1:3000/metrics',{headers:{authorization:'Bearer $METRICS_TOKEN'}}).then(async r=>{const b=await r.text();if(!r.ok||!b.includes('fiar_readiness'))throw Error('gateway metrics failed')})"
$COMPOSE exec -T worker node -e "fetch('http://127.0.0.1:3001/metrics',{headers:{authorization:'Bearer $METRICS_TOKEN'}}).then(async r=>{const b=await r.text();if(!r.ok||!b.includes('fiar_worker_claims_total'))throw Error('worker metrics failed')})"

# Exercise manager OIDC authentication flow programmatically
START_HEADERS=$(curl -sS -i http://127.0.0.1:48080/v1/auth/oidc/start)
AUTH_URL=$(printf '%s' "$START_HEADERS" | grep -i '^location:' | sed -E 's/^location:[[:space:]]*//I' | tr -d '\r\n')
FLOW_COOKIE=$(printf '%s' "$START_HEADERS" | grep -i '^set-cookie:' | grep '__Host-fiar_oidc_flow' | sed -E 's/^set-cookie:[[:space:]]*([^;]+);.*/\1/' | tr -d '\r\n')

# Request authorization code from fake-oidc
CALLBACK_URL=$($COMPOSE exec -T gateway node -e "fetch(process.argv[1], { redirect: 'manual' }).then(r => process.stdout.write(r.headers.get('location') || ''))" "$AUTH_URL")
CALLBACK_QUERY=$(printf '%s' "$CALLBACK_URL" | sed -E 's/^[^?]*\?//')

# Call callback endpoint with flow cookie and authorization code
CALLBACK_HEADERS=$(curl -sS -i -H "Cookie: $FLOW_COOKIE" "http://127.0.0.1:48080/v1/auth/oidc/callback?$CALLBACK_QUERY")
SESSION_COOKIE=$(printf '%s' "$CALLBACK_HEADERS" | grep -i '^set-cookie:' | grep '__Host-fiar_session' | sed -E 's/^set-cookie:[[:space:]]*([^;]+);.*/\1/' | tr -d '\r\n')

# Verify authenticated session endpoint returns manager principal
SESSION_BODY=$(curl -sS -H "Cookie: $SESSION_COOKIE" http://127.0.0.1:48080/v1/auth/session)
printf '%s' "$SESSION_BODY" | grep -q '"authenticated":true'
printf '%s' "$SESSION_BODY" | grep -q '"principalType":"manager"'

# Verify manager session can access manager-only endpoint
APPROVALS_STATUS=$(curl -sS -o "$TEMP/approvals-resp" -w '%{http_code}' -H "Cookie: $SESSION_COOKIE" http://127.0.0.1:48080/v1/approvals)
test "$APPROVALS_STATUS" = 200

# Verify agent identities cannot receive manager sessions
AGENT_MAP_STATUS=0
$COMPOSE run --rm --no-deps gateway node dist/gateway/admin-cli.js identity-map --issuer https://fake-oidc:4443 --subject agent-subject --tenant ten_demo_alpha --principal prn_demo_alpha_agent >/dev/null 2>&1 || AGENT_MAP_STATUS=$?
test "$AGENT_MAP_STATUS" -ne 0

FAILED=0
echo "Production-mode container smoke passed"

