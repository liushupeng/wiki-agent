import type { AgentConfig, IAgent, IMemory, IToolRegistry } from '../../types.js';
import { NativeAgent } from './agent.js';

export { NativeAgent } from './agent.js';

export function createNativeAgent(
    config: AgentConfig,
    memory: IMemory,
    registry: IToolRegistry
): IAgent {
    return new NativeAgent(config, memory, registry);
}
