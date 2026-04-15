// No-op shim for optional NestJS modules that are not used in this Worker.
// Wrangler module alias points optional imports here to avoid bundling
// transports/adapters that are irrelevant for createApplicationContext().

export {};
