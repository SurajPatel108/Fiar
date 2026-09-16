import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const host = process.env.FAKE_OIDC_HOST ?? 'fake-oidc';
const port = Number(process.env.FAKE_OIDC_PORT ?? '4443');
const issuer = `https://${host}:${port}`;
const server = createServer({ key: readFileSync('/run/tls/key.pem'), cert: readFileSync('/run/tls/cert.pem') }, (request, response) => {
  if (request.url === '/.well-known/openid-configuration') return json(response, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, code_challenge_methods_supported: ['S256'] });
  if (request.url === '/jwks') return json(response, { keys: [] });
  if (request.url === '/health/live') return json(response, { status: 'live' });
  response.statusCode = 404; response.end();
});
server.listen(port, '0.0.0.0');
function json(response, value) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); }
