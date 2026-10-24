// Runs the host smoke suite (out/hostTests.js) in a downloaded VS Code with a throwaway profile.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const root = path.resolve(__dirname, '..');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'csbridge-host-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'csbridge-ws-'));
    try {
        await runTests({
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(root, 'out', 'hostTests.js'),
            launchArgs: [workspace, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust'],
            extensionTestsEnv: { CSBRIDGE_USER_DATA: userData },
        });
    }
    finally {
        for (const dir of [userData, workspace]) { fs.rmSync(dir, { recursive: true, force: true }); }
    }
}

main().catch(err => { console.error(err); process.exit(1); });
