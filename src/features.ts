// Named features and their stage: an experimental one is on only with csbridge.experimentalFeatures, and an unknown name
// is off. docs/ARCHITECTURE.md has the lifecycle.
import * as vscode from 'vscode';

const FEATURES: Record<string, 'experimental' | 'stable'> = { cybershuttle: 'experimental' };

export const enabled = (feature: string): boolean => FEATURES[feature] === 'stable'
    || (FEATURES[feature] === 'experimental' && vscode.workspace.getConfiguration('csbridge').get('experimentalFeatures', false));
