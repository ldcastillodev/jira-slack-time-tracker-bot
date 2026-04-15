import { Injectable } from "@nestjs/common";
import { requestStorage, type RequestStore } from "./async-local-storage.ts";
import type { Env } from "../common/types/index.ts";

/**
 * Singleton service that provides access to the per-request Cloudflare
 * `env` and `ctx` via AsyncLocalStorage.
 *
 * Every fetch/scheduled handler wraps its work in `runInContext(env, ctx, fn)`,
 * making the bindings available to all downstream @Injectable() services
 * without passing them as function parameters.
 */
@Injectable()
export class RequestContextService {
  private get store(): RequestStore {
    const store = requestStorage.getStore();
    if (!store) {
      throw new Error(
        "RequestContextService accessed outside of a request context. " +
          "Ensure the handler is wrapped in runInContext().",
      );
    }
    return store;
  }

  get env(): Env {
    return this.store.env;
  }

  get ctx(): ExecutionContext {
    return this.store.ctx;
  }
}
