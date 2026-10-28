import * as oidc from 'openid-client';
import { groupEntries } from './access.mjs';

const issuer = 'https://school.example';
export const callback = 'https://apps.school.example/bbsinfo/oidc/callback';

class AuthStepError extends Error {
  constructor(step, cause) {
    super('IServ-Anmeldung fehlgeschlagen.', { cause });
    this.step = step;
  }
}

export function mergeVerifiedGroups(info, idTokenClaims) {
  const userInfoGroups = groupEntries(info['iserv:groups']);
  if (Array.isArray(info['iserv:groups']) || userInfoGroups.length) return { ...info, 'iserv:groups': userInfoGroups };
  const idTokenGroups = groupEntries(idTokenClaims['iserv:groups']);
  return idTokenGroups.length ? { ...info, 'iserv:groups': idTokenGroups } : info;
}

const claimType = (value) => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? `object_${Math.min(Object.keys(value).length, 999)}` : typeof value;

export async function provider(clientId, secret, fetchImplementation = fetch) {
  const safeFetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== issuer) throw new Error('Unerwartete OIDC-Adresse.');
    return fetchImplementation(input, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
  };
  const config = await oidc.discovery(
    new URL(issuer), clientId,
    { client_secret: secret, id_token_signed_response_alg: 'RS256' },
    oidc.ClientSecretPost(secret),
    { [oidc.customFetch]: safeFetch, execute: [oidc.enableNonRepudiationChecks], timeout: 8 },
  );
  return {
    async begin() {
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: callback,
        scope: 'openid profile email iserv:uuid iserv:groups iserv:roles',
        response_type: 'code',
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256', state, nonce,
      });
      return { verifier, state, nonce, url: url.href };
    },
    async complete(url, transaction) {
      let tokens;
      let claims;
      try {
        tokens = await oidc.authorizationCodeGrant(config, url, {
          pkceCodeVerifier: transaction.verifier,
          expectedState: transaction.state,
          expectedNonce: transaction.nonce,
          idTokenExpected: true,
        });
        claims = tokens.claims();
        if (!claims?.sub || !Number.isFinite(claims.exp) || !tokens.access_token) throw new Error('Ungültige IServ-Identität.');
      } catch (error) {
        throw new AuthStepError('token', error);
      }
      let info;
      try {
        info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      } catch (error) {
        throw new AuthStepError('userinfo', error);
      }
      return {
        subject: claims.sub, info: mergeVerifiedGroups(info, claims),
        groupSources: { userInfo: claimType(info['iserv:groups']), idToken: claimType(claims['iserv:groups']) },
        accessToken: tokens.access_token,
        expires: Math.min(claims.exp * 1000, Date.now() + Math.max(0, Number(tokens.expires_in || 300)) * 1000, Date.now() + 3600000),
      };
    },
    async refresh(session) {
      return oidc.fetchUserInfo(config, session.accessToken, session.subject);
    },
  };
}
