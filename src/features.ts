// Named features and their stage. An experimental feature is on only with csbridge.experimentalFeatures; graduating one
// is marking it 'stable' here, and retiring its flag later is deleting the entry and the enabled() calls naming it. An
// unknown name is off. Each feature is also a csbridge.feature.<name> context key, for package.json when clauses.
import * as vscode from 'vscode';

const FEATURES: Record<string, 'experimental' | 'stable'> = { cybershuttle: 'experimental' };

export const enabled = (feature: string): boolean => FEATURES[feature] === 'stable'
    || (FEATURES[feature] === 'experimental' && vscode.workspace.getConfiguration('csbridge').get('experimentalFeatures', false));

export function watchFeatures(): vscode.Disposable {
    const sync = () => Object.keys(FEATURES).forEach(f => void vscode.commands.executeCommand('setContext', `csbridge.feature.${f}`, enabled(f)));
    sync();
    return vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('csbridge.experimentalFeatures')) { sync(); } });
}
