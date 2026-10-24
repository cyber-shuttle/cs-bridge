// Entry of the host smoke suite: VS Code loads this bundle as the extension test and calls run().
import Mocha from 'mocha';
import { register } from './smoke';

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'bdd', timeout: 120_000, color: true });
    mocha.suite.emit('pre-require', globalThis, 'smoke', mocha);
    register();
    return new Promise((resolve, reject) => mocha.run(failures => (failures ? reject(new Error(`${failures} host test(s) failed`)) : resolve())));
}
