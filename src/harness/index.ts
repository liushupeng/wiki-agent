import type { AgentConfig, IAgent, IMemory, IToolRegistry } from '../types.js';
import { createNativeAgent } from './native/index.js';
import { createPiAgent } from './pi/index.js';
import type { HarnessKind } from './types.js';

export type { HarnessKind } from './types.js';
export { HARNESS_KINDS, isHarnessKind, parseHarnessFromArgv, resolveHarnessFromEnv } from './types.js';
export { createNativeAgent, NativeAgent } from './native/index.js';
export { createPiAgent, PiAgent, listWikiToolsForPi } from './pi/index.js';

export function createHarnessAgent(
    harness: HarnessKind,
    config: AgentConfig,
    memory: IMemory,
    registry: IToolRegistry
): IAgent {
    return harness === 'pi'
        ? createPiAgent(config, memory, registry)
        : createNativeAgent(config, memory, registry);
}

export function harnessLabel(harness: HarnessKind): string {
    return harness === 'pi' ? 'Pi' : 'native（内置 loop）';
}
