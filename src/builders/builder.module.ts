import { Module } from "@nestjs/common";
import { MessageBuilderService } from "./message-builder.service.ts";

@Module({
  providers: [MessageBuilderService],
  exports: [MessageBuilderService],
})
export class BuilderModule {}
