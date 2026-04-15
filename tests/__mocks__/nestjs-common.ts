/**
 * Stub for @nestjs/common — provides no-op decorator factories
 * so that service/handler classes can be imported in the Cloudflare
 * Workers test pool without pulling in the full NestJS runtime.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Class decorator factories
export const Injectable = () => (target: any) => target;
export const Global = () => (target: any) => target;
export const Module = (_metadata?: any) => (target: any) => target;
