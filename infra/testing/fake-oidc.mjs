import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

const host = process.env.FAKE_OIDC_HOST ?? 'fake-oidc';
const port = Number(process.env.FAKE_OIDC_PORT ?? '4443');
const issuer = `https://${host}:${port}`;

// Test-only RSA keypair generated strictly in-memory for testing
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'jwk' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const keyId = 'test-smoke-key-1';
const jwk = {
  kty: publicKey.kty,
  n: publicKey.n,
  e: publicKey.e,
  kid: keyId,
  alg: 'RS256',
  use: 'sig',
};

const pendingCodes = new Map();

function signJwt(header, payload) {
  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${encHeader}.${encPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64url');
  return `${data}.${signature}`;
}

const server = createServer({ key: readFileSync('/run/tls/key.pem'), cert: readFileSync('/run/tls/cert.pem') }, async (request, response) => {
  const url = new URL(request.url ?? '/', issuer);

  if (url.pathname === '/.well-known/openid-configuration') {
    return json(response, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });
  }

  if (url.pathname === '/jwks') {
    return json(response, { keys: [jwk] });
  }

  if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
    return json(response, { status: 'live' });
  }

  if (url.pathname === '/authorize' && request.method === 'GET') {
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    const codeChallenge = url.searchParams.get('code_challenge');
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');
    const subject = url.searchParams.get('subject') || 'manager-subject';

    if (!redirectUri || !state || !codeChallenge || codeChallengeMethod !== 'S256') {
      response.statusCode = 400;
      return json(response, { error: 'invalid_request' });
    }

    const code = randomBytes(24).toString('hex');
    pendingCodes.set(code, {
      clientId,
      redirectUri,
      state,
      nonce: nonce || '',
      codeChallenge,
      codeChallengeMethod,
      subject,
      expiresAt: Date.now() + 300_000,
    });

    const targetUrl = new URL(redirectUri);
    targetUrl.searchParams.set('code', code);
    targetUrl.searchParams.set('state', state);

    response.statusCode = 302;
    response.setHeader('location', targetUrl.toString());
    response.end();
    return;
  }

  if (url.pathname === '/token' && request.method === 'POST') {
    const body = await readBody(request);
    const params = new URLSearchParams(body);
    const grantType = params.get('grant_type');
    const code = params.get('code');
    const redirectUri = params.get('redirect_uri');
    const clientId = params.get('client_id');
    const codeVerifier = params.get('code_verifier');

    if (grantType !== 'authorization_code' || !code || !codeVerifier) {
      response.statusCode = 400;
      return json(response, { error: 'invalid_request' });
    }

    const entry = pendingCodes.get(code);
    if (!entry) {
      response.statusCode = 400;
      return json(response, { error: 'invalid_grant' });
    }
    pendingCodes.delete(code);

    if (entry.expiresAt < Date.now()) {
      response.statusCode = 400;
      return json(response, { error: 'invalid_grant' });
    }

    const computedChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (computedChallenge !== entry.codeChallenge) {
      response.statusCode = 400;
      return json(response, { error: 'invalid_grant' });
    }

    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt(
      { alg: 'RS256', kid: keyId, typ: 'JWT' },
      {
        iss: issuer,
        aud: clientId || entry.clientId,
        sub: entry.subject,
        nonce: entry.nonce,
        iat: now,
        exp: now + 300,
      }
    );

    return json(response, {
      access_token: randomBytes(16).toString('hex'),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  }

  response.statusCode = 404;
  response.end();
});

server.listen(port, '0.0.0.0');

function json(response, value) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) {
        request.destroy();
        reject(new Error('Body too large'));
      }
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}
