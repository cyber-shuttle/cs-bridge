// Named features and their stage: an experimental one is on only with csbridge.experimentalFeatures. docs/ARCHITECTURE.md
// has the lifecycle.
import * as vscode from 'vscode';

type Feature = 'cybershuttle' | 'aws';
const FEATURES: Record<Feature, 'experimental' | 'stable'> = { cybershuttle: 'experimental', aws: 'experimental' };

export const enabled = (feature: Feature): boolean => FEATURES[feature] === 'stable'
    || (FEATURES[feature] === 'experimental' && vscode.workspace.getConfiguration('csbridge').get('experimentalFeatures', false));
