import { Injectable } from "@nestjs/common";
import { RequestContextService } from "../context/request-context.service.ts";
import { loadConfig } from "./config.loader.ts";
import type { TrackerConfig, JiraConfig, JiraUsers } from "../common/types/index.ts";

@Injectable()
export class ConfigService {
  private cachedConfig: TrackerConfig | null = null;

  constructor(private readonly requestContext: RequestContextService) {}

  get config(): TrackerConfig {
    if (!this.cachedConfig) {
      this.cachedConfig = loadConfig();
    }
    return this.cachedConfig;
  }

  get jiraConfig(): JiraConfig {
    return JSON.parse(this.requestContext.env.JIRA_CONFIG) as JiraConfig;
  }

  get users(): JiraUsers {
    return JSON.parse(this.requestContext.env.USERS) as JiraUsers;
  }

  get userEmails(): string[] {
    return Object.keys(this.users);
  }
}
