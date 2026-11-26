import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Google sign-in (OpenID Connect, authorization code flow with PKCE).
 * Only users an admin already created can sign in; the Google email must match theirs.
 */

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export interface GoogleClient {
  authUrl(params: { state: string; nonce: string; codeChallenge: string }): string;
  exchange(params: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity>;
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function createGoogleClient(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): GoogleClient {
  return {
    authUrl({ state, nonce, codeChallenge }) {
      const url = new URL(AUTH_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      return url.toString();
    },

    async exchange({ code, codeVerifier, nonce }) {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          code_verifier: codeVerifier,
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          redirect_uri: opts.redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!res.ok) throw new Error(`Google token exchange failed with ${res.status}`);
      const body = (await res.json()) as { id_token?: string };
      if (!body.id_token) throw new Error('Google returned no id_token');

      const { payload } = await jwtVerify(body.id_token, jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: opts.clientId,
      });
      if (payload.nonce !== nonce) throw new Error('Google id_token nonce mismatch');
      if (!payload.sub || typeof payload.email !== 'string') {
        throw new Error('Google id_token has no subject or email');
      }
      return {
        sub: payload.sub,
        email: payload.email.toLowerCase(),
        emailVerified: payload.email_verified === true,
      };
    },
  };
}

export function newPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
