/**
 * The generic HTTP credential types every workflow can use.
 *
 * Each is a manifest (data, safe for the browser) and a resolver (server
 * only) that turns the stored values into a capability: headers for
 * `httpAuth@1`, a request rewrite for `httpSigner@1`. A box that accepts
 * either — HTTP Request, the measuring boxes — works with all four, and with
 * any credential type a later pack adds, without knowing which it got.
 */

import { defineCredentialResolver, defineCredentialType, type CredentialTypeDefinition, type HttpRequestDraft } from '@goblin/node-sdk';
import type { CredentialTypeManifest } from '@goblin/spec';

export const bearerTokenType = defineCredentialType({
  type: 'http.bearerToken',
  version: 1,
  title: 'Bearer token',
  description: 'Sends "Authorization: Bearer <token>" with every request.',
  provides: ['httpAuth@1'],
  fields: [{ name: 'token', label: 'Token', secret: true, required: true }],
});

export const headerKeyType = defineCredentialType({
  type: 'http.headerKey',
  version: 1,
  title: 'API key in a header',
  description: 'Sends the key in a header of your choosing, like x-api-key.',
  provides: ['httpAuth@1'],
  fields: [
    { name: 'header', label: 'Header name', required: true, default: 'x-api-key' },
    { name: 'value', label: 'Key', secret: true, required: true },
  ],
});

export const basicAuthType = defineCredentialType({
  type: 'http.basicAuth',
  version: 1,
  title: 'Username and password',
  description: 'HTTP basic authentication.',
  provides: ['httpAuth@1'],
  fields: [
    { name: 'username', label: 'Username', required: true },
    { name: 'password', label: 'Password', secret: true, required: true },
  ],
});

export const queryKeyType = defineCredentialType({
  type: 'http.queryKey',
  version: 1,
  title: 'API key in the address',
  description: 'Adds the key to every request’s address, as ?api_key=… or a name you choose.',
  provides: ['httpSigner@1'],
  fields: [
    { name: 'param', label: 'Parameter name', required: true, default: 'api_key' },
    { name: 'value', label: 'Key', secret: true, required: true },
  ],
});

/** Browser-safe: what the Credentials screen needs to draw its forms. */
export const coreCredentialTypes: CredentialTypeManifest[] = [bearerTokenType, headerKeyType, basicAuthType, queryKeyType];

/** Base64 of UTF-8, so a password with "é" in it encodes the way servers expect. */
function base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Server only. */
export const coreCredentialResolvers: CredentialTypeDefinition[] = [
  defineCredentialResolver(bearerTokenType, (v) => ({ value: { headers: { authorization: `Bearer ${v['token'] ?? ''}` } } })),
  defineCredentialResolver(headerKeyType, (v) => ({ value: { headers: { [(v['header'] || 'x-api-key').toLowerCase()]: v['value'] ?? '' } } })),
  defineCredentialResolver(basicAuthType, (v) => ({
    value: { headers: { authorization: `Basic ${base64(`${v['username'] ?? ''}:${v['password'] ?? ''}`)}` } },
  })),
  defineCredentialResolver(queryKeyType, (v) => ({
    value: {
      sign(request: HttpRequestDraft): HttpRequestDraft {
        const url = new URL(request.url);
        url.searchParams.set(v['param'] || 'api_key', v['value'] ?? '');
        return { ...request, url: url.toString() };
      },
    },
  })),
];
