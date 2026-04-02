// ─── Cloudflare Worker Environment ───

export interface Env {
  CACHE: KVNamespace;
  JIRA_BASE_URL: string;
  JIRA_API_TOKEN: string;
  JIRA_USER_EMAIL: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
}

// ─── Configuration ───

export interface GenericTicket {
  key: string;
  label: string;
}

interface ProjectComponent {
  name: string;
}

export interface TrackerConfig {
  jira: {
    boards: string[];
    genericTickets: GenericTicket[];
    projectComponents: ProjectComponent[];
  };
  tracking: {
    dailyTarget: number;
    weeklyTarget: number;
    timezone: string;
    cronHourET: number;
  };
  users: string[];
}

// ─── Jira Types ───

export interface JiraWorklog {
  id: string;
  issueKey: string;
  issueSummary: string;
  authorAccountId: string;
  authorEmail?: string;
  authorDisplayName: string;
  started: string;
  timeSpentSeconds: number;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  assigneeAccountId: string | null;
  assigneeEmail: string | null;
  assigneeDisplayName: string | null;
  worklogs: JiraWorklog[];
}

export interface JiraSearchResponse {
  issues: JiraSearchIssue[];
  nextPageToken?: string;
}

export interface JiraSearchIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee: {
      accountId: string;
      emailAddress?: string;
      displayName: string;
    } | null;
    worklog?: {
      total: number;
      maxResults: number;
      worklogs: JiraRawWorklog[];
    };
  };
}

export interface JiraRawWorklog {
  id: string;
  author: {
    accountId: string;
    emailAddress?: string;
    displayName: string;
  };
  started: string;
  timeSpentSeconds: number;
}

export interface JiraWorklogResponse {
  total: number;
  maxResults: number;
  startAt: number;
  worklogs: JiraRawWorklog[];
}

// ─── Aggregation Types ───

export interface SlotEntry {
  ticketKey: string;
  hours: number;
}

export interface TicketHours {
  key: string;
  summary: string;
  hours: number;
}

export interface UserHoursSummary {
  email: string;
  displayName: string;
  totalHours: number;
  tickets: TicketHours[];
  assignedTicketKeys: string[];
}

export interface DailyBreakdown {
  date: string;
  totalHours: number;
  tickets: TicketHours[];
}

export interface WeeklyBreakdown {
  email: string;
  displayName: string;
  weekTotal: number;
  days: DailyBreakdown[];
}

// ─── Slack Types ───

export interface SlackBlock {
  type: string;
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  elements?: SlackElement[];
  block_id?: string;
  accessory?: SlackElement;
  label?: SlackTextObject;
  element?: SlackElement;
  dispatch_action?: boolean;
}

export interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

export interface SlackOption {
  text: SlackTextObject;
  value: string;
}

export interface SlackElement {
  type: string;
  action_id?: string;
  text?: SlackTextObject;
  value?: string;
  style?: string;
  options?: SlackOption[];
  placeholder?: SlackTextObject;
  initial_option?: SlackOption;
}

export interface SlackInteractionPayload {
  type: string;
  user: {
    id: string;
    username: string;
    name: string;
    team_id: string;
  };
  trigger_id: string;
  response_url: string;
  actions: SlackAction[];
  message?: {
    ts: string;
    blocks: SlackBlock[];
  };
  state?: {
    values: Record<string, Record<string, { type: string; selected_option?: SlackOption }>>;
  };
}

export interface SlackAction {
  type: string;
  action_id: string;
  block_id: string;
  value?: string;
  selected_option?: SlackOption;
  action_ts: string;
}
