import { Global, Module } from "@nestjs/common";
import { RequestContextService } from "./request-context.service.ts";

@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class ContextModule {}
