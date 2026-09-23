/**
 * Context propagation (run, agent, step). Uses AsyncLocalStorage when the runtime has it
 * (Node >= 20 via process.getBuiltinModule, or a global on edge runtimes). Otherwise it falls
 * back to a synchronous stack, which is correct for sync code and best-effort for async code.
 */
export interface AgentRef {
  agentId: string;
  teamId: string | null;
}

export interface Ctx {
  runId?: string;
  agent?: AgentRef;
  stepId?: string;
}

interface Als<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

function findAls(): (new () => Als<Ctx>) | null {
  const g = globalThis as { AsyncLocalStorage?: new () => Als<Ctx>; process?: { getBuiltinModule?: (id: string) => unknown } };
  if (g.AsyncLocalStorage) return g.AsyncLocalStorage;
  try {
    const mod = g.process?.getBuiltinModule?.("node:async_hooks") as { AsyncLocalStorage?: new () => Als<Ctx> } | undefined;
    if (mod?.AsyncLocalStorage) return mod.AsyncLocalStorage;
  } catch {
    // not available
  }
  return null;
}

class StackStorage implements Als<Ctx> {
  private stack: Ctx[] = [];
  getStore() {
    return this.stack.at(-1);
  }
  run<R>(store: Ctx, fn: () => R): R {
    this.stack.push(store);
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }
}

const AlsCtor = findAls();
const storage: Als<Ctx> = AlsCtor ? new AlsCtor() : new StackStorage();

export const hasAsyncContext = AlsCtor !== null;

export function current(): Ctx {
  return storage.getStore() ?? {};
}

export function withCtx<R>(patch: Ctx, fn: () => R): R {
  return storage.run({ ...current(), ...patch }, fn);
}
