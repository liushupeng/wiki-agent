import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHarnessFromArgv, resolveHarnessFromEnv } from '../../harness/types.js';

test('resolveHarnessFromEnv defaults to native', () => {
    assert.equal(resolveHarnessFromEnv({}), 'native');
    assert.equal(resolveHarnessFromEnv({ HARNESS: 'pi' }), 'pi');
});

test('parseHarnessFromArgv strips --harness and leaves other args', () => {
    assert.deepEqual(parseHarnessFromArgv(['--harness', 'native', 'hello'], {}), {
        harness: 'native',
        argv: ['hello']
    });
    assert.throws(() => parseHarnessFromArgv(['--harness', 'unknown'], {}));
});
