/**
 * @goblin/nodes-aws — the AWS provider pack.
 *
 * For now it ships one thing: a credential type that signs you in to an API
 * behind Amazon Cognito using a refresh token, minting a fresh ID (or
 * access) token when a box needs one. Any box that accepts `httpAuth@1` can
 * use it — HTTP Request, the measuring boxes — without knowing Cognito exists.
 *
 * The token is minted through `ctx.http` like any other call, cached until a
 * minute before it expires, and minted once however many boxes ask at the
 * same moment (the credential runtime does both). A refresh token Cognito
 * refuses marks the credential "needs signing in again" instead of retrying.
 *
 * Later S3 and SQS boxes will sign requests with SigV4, as a pack-defined
 * capability (`aws.sigv4@1`) — which the capability model already allows.
 */

import { CredentialAuthError, defineCredentialResolver, defineCredentialType, NodeFailure, type CredentialTypeDefinition, type NodeDefinition } from '@goblin/node-sdk';
import type { CredentialTypeManifest, NodeManifest } from '@goblin/spec';

export const cognitoRefreshTokenType = defineCredentialType({
  type: 'aws.cognito.refreshToken',
  version: 1,
  title: 'AWS Cognito (refresh token)',
  description: 'Signs in to an API behind Cognito. A fresh token is fetched when a box needs one, from the refresh token you paste once.',
  provides: ['httpAuth@1'],
  fields: [
    { name: 'region', label: 'Region', required: true, description: 'Where the user pool lives, e.g. ap-south-1.' },
    { name: 'clientId', label: 'App client id', required: true, description: 'The web app’s client id. It must allow ALLOW_REFRESH_TOKEN_AUTH (the default).' },
    {
      name: 'refreshToken',
      label: 'Refresh token',
      secret: true,
      required: true,
      description: 'After signing in to the web app: localStorage, CognitoIdentityServiceProvider.<clientId>.<user>.refreshToken.',
    },
    { name: 'token', label: 'Send', type: 'select', options: ['ID token', 'Access token'], default: 'ID token' },
    { name: 'format', label: 'Authorization header', type: 'select', options: ['Bearer <token>', '<token>'], default: 'Bearer <token>' },
  ],
});

/** The region goes into a host name, so it is held to the shape AWS uses. */
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** Errors that mean the refresh token itself is no good: sign in again. */
const REAUTH = new Set(['NotAuthorizedException', 'UserNotFoundException', 'UserNotConfirmedException', 'PasswordResetRequiredException']);

interface CognitoAnswer {
  AuthenticationResult?: { IdToken?: string; AccessToken?: string; ExpiresIn?: number };
  __type?: string;
  message?: string;
}

export const cognitoRefreshToken = defineCredentialResolver(cognitoRefreshTokenType, async (values, rctx) => {
  const region = (values['region'] ?? '').trim();
  if (!REGION.test(region)) {
    throw new NodeFailure(`"${region}" is not an AWS region. It looks like ap-south-1 or us-east-1.`, { code: 'COGNITO_REGION', errorClass: 'validation' });
  }
  const res = await rctx.http.request({
    method: 'POST',
    url: `https://cognito-idp.${region}.amazonaws.com/`,
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: (values['clientId'] ?? '').trim(),
      AuthParameters: { REFRESH_TOKEN: values['refreshToken'] ?? '' },
    }),
    signal: rctx.signal,
    timeoutMs: 15_000,
    maxResponseBytes: 256 * 1024,
  });

  let answer: CognitoAnswer = {};
  try {
    answer = res.json<CognitoAnswer>();
  } catch {
    // Not JSON: fall through to the status check.
  }
  if (!res.ok) {
    const kind = (answer.__type ?? '').split('#').pop() ?? '';
    const said = answer.message ?? `HTTP ${res.status}`;
    if (REAUTH.has(kind)) throw new CredentialAuthError(said);
    if (res.status >= 500 || res.status === 429 || kind === 'TooManyRequestsException') {
      throw new NodeFailure(`Cognito is not answering properly right now (${said}).`, { code: 'COGNITO_UNAVAILABLE', errorClass: 'transient' });
    }
    throw new NodeFailure(`Cognito refused the sign-in: ${said}. Check the region and app client id.`, { code: `COGNITO_${kind || res.status}`, errorClass: 'validation' });
  }

  const result = answer.AuthenticationResult ?? {};
  const token = values['token'] === 'Access token' ? result.AccessToken : result.IdToken;
  if (!token) {
    throw new NodeFailure('Cognito answered without the token asked for.', { code: 'COGNITO_NO_TOKEN', errorClass: 'permanent' });
  }
  const header = values['format'] === '<token>' ? token : `Bearer ${token}`;
  return {
    value: { headers: { authorization: header } },
    expiresAt: rctx.now() + (result.ExpiresIn ?? 3600) * 1000,
    secrets: [result.IdToken, result.AccessToken].filter((t): t is string => !!t),
  };
});

/** Browser-safe. */
export const awsCredentialTypes: CredentialTypeManifest[] = [cognitoRefreshTokenType];
/** Server only. */
export const awsCredentialResolvers: CredentialTypeDefinition[] = [cognitoRefreshToken];
/** No boxes yet — S3 and SQS come later. */
export const awsManifests: NodeManifest[] = [];
export const awsNodes: NodeDefinition[] = [];
