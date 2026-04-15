import { Module } from "@nestjs/common";
import { ConfigService } from "./config.service.ts";

@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
