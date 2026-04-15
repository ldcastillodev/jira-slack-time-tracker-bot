import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.ts";
import { JiraService } from "./jira.service.ts";

@Module({
  imports: [ConfigModule],
  providers: [JiraService],
  exports: [JiraService],
})
export class JiraModule {}
