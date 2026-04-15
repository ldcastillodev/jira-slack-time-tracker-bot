import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../common/types/index.ts";

export interface RequestStore {
  env: Env;
  ctx: ExecutionContext;
}

export const requestStorage = new AsyncLocalStorage<RequestStore>();

/**
 * Runs a callback within an AsyncLocalStorage context that carries
 * the per-request Cloudflare `env` and `ctx` bindings.
 */
export function runInContext<T>(env: Env, ctx: ExecutionContext, fn: () => T): T {
  return requestStorage.run({ env, ctx }, fn);
}
