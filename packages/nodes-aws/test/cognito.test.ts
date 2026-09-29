import { describe, expect, it } from 'vitest';

import { CredentialRuntime, InMemoryCredentialStore, MockHttp, NodeFailure } from '@goblin/node-sdk';
import { awsCredentialResolvers, awsManifests, awsNodes, cognitoRefreshToken } from '@goblin/nodes-aws';
import { checkCredentialPack, checkNodePack } from '@goblin/testing';

const COGNITO = 'POST https://cognito-idp.ap-south-1.amazonaws.com/';
const values = { region: 'ap-south-1', clientId: 'client-123', refreshToken: 'refresh-abcdefgh' };
const signed = (id: string, expiresIn = 3600) => ({ AuthenticationResult: { IdToken: id, AccessToken: `access-${id}`, ExpiresIn: expiresIn, TokenType: 'Bearer' } });

function setup() {
  const http = new MockHttp();
  let now = 1_700_000_000_000;
  const store = new InMemoryCredentialStore();
  const runtime = new CredentialRuntime({ store, types: awsCredentialResolvers, http: http.client(), now: () => now });
  const resolve = async (id: string) => runtime.resolve({ id, type: 'aws.cognito.refreshToken' }, { accepts: ['httpAuth@1'], signal: new AbortController().signal });
  return { http, store, resolve, advance: (ms: number) => (now += ms) };
}

async function failure(promise: Promise<unknown>): Promise<NodeFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NodeFailure) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('AWS Cognito (refresh token)', () => {
  it('passes the credential and node pack contracts', async () => {
    const http = new MockHttp();
    http.mock(COGNITO).reply(200, signed('id-token-1'));
    expect(await checkCredentialPack({ types: awsCredentialResolvers, samples: { 'aws.cognito.refreshToken': values }, http: http.client() })).toEqual([]);
    expect(checkNodePack({ manifests: awsManifests, nodes: awsNodes })).toEqual([]);
  });

  it('asks Cognito for a fresh ID token with REFRESH_TOKEN_AUTH, and sends it as a bearer token', async () => {
    const { http, store, resolve } = setup();
    http.mock(COGNITO).reply(200, signed('id-token-1'));
    const cred = await store.create({ type: 'aws.cognito.refreshToken', name: 'Dev', values });
    const resolved = await resolve(cred.id);

    expect(resolved.value).toEqual({ headers: { authorization: 'Bearer id-token-1' } });
    expect(resolved.secrets).toEqual(expect.arrayContaining(['id-token-1', 'access-id-token-1', 'refresh-abcdefgh']));
    const call = http.calls[0]!;
    expect(call.headers['x-amz-target']).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    expect(call.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(JSON.parse(call.body!)).toEqual({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: 'client-123', AuthParameters: { REFRESH_TOKEN: 'refresh-abcdefgh' } });
  });

  it('can send the access token instead, without "Bearer"', async () => {
    const { http, store, resolve } = setup();
    http.mock(COGNITO).reply(200, signed('id-1'));
    const cred = await store.create({ type: 'aws.cognito.refreshToken', name: 'Dev', values: { ...values, token: 'Access token', format: '<token>' } });
    expect((await resolve(cred.id)).value).toEqual({ headers: { authorization: 'access-id-1' } });
  });

  it('reuses the token until a minute before it expires, then fetches a new one', async () => {
    const { http, store, resolve, advance } = setup();
    http.mock(COGNITO).replyTimes(1, 200, signed('first', 3600)).reply(200, signed('second', 3600));
    const cred = await store.create({ type: 'aws.cognito.refreshToken', name: 'Dev', values });

    expect((await resolve(cred.id)).value).toEqual({ headers: { authorization: 'Bearer first' } });
    advance(58 * 60_000);
    expect((await resolve(cred.id)).value).toEqual({ headers: { authorization: 'Bearer first' } });
    expect(http.calls).toHaveLength(1);
    advance(60_000); // 59 minutes: inside the minute's margin
    expect((await resolve(cred.id)).value).toEqual({ headers: { authorization: 'Bearer second' } });
    expect(http.calls).toHaveLength(2);
  });

  it('a refused refresh token means signing in again, not retrying', async () => {
    const { http, store, resolve } = setup();
    http.mock(COGNITO).reply(400, { __type: 'NotAuthorizedException', message: 'Refresh Token has expired' });
    const cred = await store.create({ type: 'aws.cognito.refreshToken', name: 'Dev pool', values });
    const error = await failure(resolve(cred.id));
    expect(error.code).toBe('NEEDS_REAUTH');
    expect(error.message).toBe('“Dev pool” needs signing in again (Refresh Token has expired). Replace its values on the Credentials screen.');
    expect((await store.get(cred.id))?.status).toBe('needs_reauth');
    await failure(resolve(cred.id));
    expect(http.calls).toHaveLength(1);
  });

  it('a Cognito outage is transient; a wrong client id is a setup problem', async () => {
    const { http, store, resolve } = setup();
    const cred = await store.create({ type: 'aws.cognito.refreshToken', name: 'Dev', values });
    http.mock(COGNITO).replyTimes(1, 503, { message: 'Service Unavailable' }).reply(400, { __type: 'ResourceNotFoundException', message: 'User pool client does not exist.' });
    const outage = await failure(resolve(cred.id));
    expect(outage).toMatchObject({ code: 'COGNITO_UNAVAILABLE', errorClass: 'transient', retryable: true });
    const setupError = await failure(resolve(cred.id));
    expect(setupError).toMatchObject({ code: 'COGNITO_ResourceNotFoundException', errorClass: 'validation', retryable: false });
    expect((await store.get(cred.id))?.status).toBe('ok');
  });

  it('will not put anything but a region into the Cognito host name', async () => {
    const error = await failure(
      Promise.resolve(
        cognitoRefreshToken.resolve({ ...values, region: 'evil.example.com/x' }, { http: new MockHttp().client(), signal: new AbortController().signal, logger: { info() {}, warn() {} }, now: Date.now }),
      ),
    );
    expect(error.code).toBe('COGNITO_REGION');
  });
});
