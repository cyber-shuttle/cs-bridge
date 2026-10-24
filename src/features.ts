// Named features and their stage: an experimental one is on only with csbridge.experimentalFeatures. docs/ARCHITECTURE.md
// has the lifecycle.
import * as vscode from 'vscode';
import type { SlurmSession } from './models';

type Feature = 'cybershuttle' | 'aws';
const FEATURES: Record<Feature, 'experimental' | 'stable'> = { cybershuttle: 'experimental', aws: 'experimental' };

export const enabled = (feature: Feature): boolean => FEATURES[feature] === 'stable'
    || (FEATURES[feature] === 'experimental' && vscode.workspace.getConfiguration('csbridge').get('experimentalFeatures', false));

// The transport a new run takes; only CyberShuttle offers a choice.
export const configuredTransport = (): SlurmSession['transport'] =>
    enabled('cybershuttle') ? vscode.workspace.getConfiguration('csbridge').get<SlurmSession['transport']>('transport', 'devtunnel') : 'devtunnel';
