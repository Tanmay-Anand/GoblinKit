/**
 * The node packs this build ships, in one place. A pack is the unit of
 * extension for boxes *and* credential types: each exports manifests (data,
 * for the browser), executors and credential resolvers (server only).
 */

import type { CredentialTypeDefinition, NodeDefinition } from '@goblin/node-sdk';
import { awsCredentialResolvers, awsManifests, awsNodes } from '@goblin/nodes-aws';
import { benchManifests, benchNodes } from '@goblin/nodes-bench';
import { coreCredentialResolvers, coreManifests, coreNodes } from '@goblin/nodes-core';
import type { NodeManifest } from '@goblin/spec';

export const manifests: NodeManifest[] = [...coreManifests, ...benchManifests, ...awsManifests];
export const nodes: NodeDefinition[] = [...coreNodes, ...benchNodes, ...awsNodes];
export const credentialTypes: CredentialTypeDefinition[] = [...coreCredentialResolvers, ...awsCredentialResolvers];
