import { App, type SlackCommandMiddlewareArgs, type SlackViewMiddlewareArgs, type ViewSubmitAction } from "@slack/bolt";
import { InMemoryLog1Port } from "./log1-port";
import { RealLog1Port } from "./real-log1-port";
import { authenticatedActor, unauthenticatedActor, type Log1Port } from "./domain";
import { FeedbackService, UpdateSubmissionService, describeLog1Error } from "./services";
import {
  makeStableCommandId,
  parseModalSubmission,
  runSlashCommand,
  type SlackApi,
  type SlackModal,
  type SlackSlashPayload,
} from "./slack";
import {
  createScopedEnvTokenResolver,
  parseModalOrigin,
  type AuthResolver,
  type AuthResolverInput,
} from "./server";

/** Options for the Socket Mode process. Credentials default to environment values. */
export type SocketModeOptions = {
  readonly workspaceId?: string;
  readonly botToken?: string;
  readonly appToken?: string;
  readonly mode?: "local" | "production";
  readonly log1Port?: Log1Port;
  readonly authResolver?: AuthResolver;
  readonly environment?: NodeJS.ProcessEnv;
};

type SlackApiClient = {
  readonly views: { open(input: { readonly trigger_id: string; readonly view: unknown }): Promise<{ readonly ok?: boolean; readonly error?: string }> };
  readonly chat: { postEphemeral(input: { readonly channel: string; readonly user: string; readonly text: string }): Promise<{ readonly ok?: boolean; readonly error?: string }> };
};

const nonEmpty = (value: string | undefined, name: string): string => {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) throw new Error(`${name} is not configured.`);
  return trimmed;
};

const workspaceFromEnvironment = (environment: NodeJS.ProcessEnv): string => {
  const configured = environment.SLACK_WORKSPACE_ID?.trim() || environment.LOGGY_WORKSPACE_ID?.trim();
  if (configured !== undefined && configured.length > 0) return configured;

  // A suffixed app token is enough to infer the target workspace when there is
  // exactly one candidate. Requiring a unique suffix avoids accidentally
  // starting a process with credentials for the wrong Slack installation.
  const suffixes = Object.keys(environment)
    .filter((key) => key.startsWith("SLACK_APP_TOKEN_") && key !== "SLACK_APP_TOKEN_WORKSPACE_ID")
    .map((key) => key.slice("SLACK_APP_TOKEN_".length))
    .filter((suffix) => suffix.length > 0 && /^[A-Za-z0-9_-]+$/.test(suffix) && (environment[`SLACK_APP_TOKEN_${suffix}`]?.trim().length ?? 0) > 0);
  const unique = [...new Set(suffixes)];
  if (unique.length === 1) return unique[0] as string;
  throw new Error("SLACK_WORKSPACE_ID is not configured and the app token suffix is not unique.");
};

const boltSlackApi = (client: SlackApiClient): SlackApi => ({
  async viewsOpen(input): Promise<void> {
    const response = await client.views.open({ trigger_id: input.triggerId, view: input.view as unknown as SlackModal });
    if (response.ok !== true) throw new Error(`Slack views.open failed: ${response.error ?? "unknown_error"}.`);
  },
  async postEphemeral(input): Promise<void> {
    const response = await client.chat.postEphemeral({ channel: input.channelId, user: input.userId, text: input.text });
    if (response.ok !== true) throw new Error(`Slack chat.postEphemeral failed: ${response.error ?? "unknown_error"}.`);
  },
});

const commandPayload = (command: SlackCommandMiddlewareArgs["command"]): SlackSlashPayload => ({
  type: "slash_command",
  command: command.command,
  text: command.text ?? "",
  user_id: command.user_id,
  team_id: command.team_id,
  ...(command.trigger_id === undefined ? {} : { trigger_id: command.trigger_id }),
  ...(command.channel_id === undefined ? {} : { channel_id: command.channel_id }),
});

const ackModalError = async (ack: (response?: { readonly response_action: "errors"; readonly errors: Record<string, string> }) => Promise<void>, message: string): Promise<void> => {
  await ack({ response_action: "errors", errors: { _form: message } });
};

const modalIdentity = (payload: ViewSubmitAction): { readonly userId: string; readonly workspaceId: string } | undefined => {
  const userId = payload.user?.id;
  const workspaceId = payload.team?.id;
  return typeof userId === "string" && userId.length > 0 && typeof workspaceId === "string" && workspaceId.length > 0
    ? { userId, workspaceId }
    : undefined;
};

/**
 * Construct the Bolt Socket Mode app used by the Cashew-style host process.
 * The app accepts one Slack installation per process; all credentials are
 * resolved from workspace-scoped environment variables before it connects.
 */
export const createSocketModeApp = (options: SocketModeOptions = {}): App => {
  const environment = options.environment ?? process.env;
  const workspaceId = options.workspaceId?.trim() || workspaceFromEnvironment(environment);
  const resolveBotToken = createScopedEnvTokenResolver("SLACK_BOT_TOKEN", environment);
  const resolveAppToken = createScopedEnvTokenResolver("SLACK_APP_TOKEN", environment);
  const resolveSyncToken = (value: string | Promise<string | undefined> | undefined, name: string): string => {
    if (typeof value !== "string") throw new Error(`${name} is not configured.`);
    return nonEmpty(value, name);
  };
  const botToken = resolveSyncToken(options.botToken ?? resolveBotToken(workspaceId), `SLACK_BOT_TOKEN_${workspaceId}`);
  const appToken = resolveSyncToken(options.appToken ?? resolveAppToken(workspaceId), `SLACK_APP_TOKEN_${workspaceId}`);
  const mode = options.mode ?? (environment.LOGGY_MODE === "local" ? "local" : "production");
  const port = options.log1Port ?? (mode === "local" ? new InMemoryLog1Port() : new RealLog1Port());
  const resolveActorToken = createScopedEnvTokenResolver("LOG1_ACTOR_TOKEN", environment);
  const authResolver = options.authResolver ?? ((input: AuthResolverInput) => resolveActorToken(input.workspaceId));
  // Defer Bolt's auth.test until app.start(). This keeps construction pure for
  // health checks and lets the Cashew-style process report connection failures
  // from its single startup promise instead of creating an unhandled rejection.
  const app = new App({ token: botToken, appToken, socketMode: true, deferInitialization: true });
  const slackApi = boltSlackApi(app.client as unknown as SlackApiClient);
  const updateService = new UpdateSubmissionService(port);
  const feedbackService = new FeedbackService(port);

  app.command("/log1", async ({ ack, command, client }) => {
    await ack();
    const payload = commandPayload(command);
    if (payload.team_id !== workspaceId) {
      if (payload.channel_id !== undefined) {
        await (client as unknown as SlackApiClient).chat.postEphemeral({ channel: payload.channel_id, user: payload.user_id, text: "This Log1 installation is not configured for that Slack workspace." }).catch(() => undefined);
      }
      return;
    }
    const actorToken = await Promise.resolve(authResolver({ workspaceId: payload.team_id, userId: payload.user_id })).catch(() => undefined);
    const actor = actorToken === undefined || actorToken.trim().length === 0
      ? unauthenticatedActor()
      : authenticatedActor({ actorId: payload.user_id, workspaceId: payload.team_id, accessToken: actorToken });
    await runSlashCommand({
      payload,
      actor,
      port,
      commandId: makeStableCommandId(`socket:${payload.trigger_id ?? `${payload.user_id}:${payload.text}`}`),
      slackApi,
      // Log1's search endpoint is consistently just over two seconds from the
      // Cashew host. Keep the lookup inside Slack's trigger lifetime while
      // allowing the live request enough room to complete.
      lookupTimeoutMs: 2_800,
    }).catch(async () => {
      if (payload.channel_id !== undefined) {
        await client.chat.postEphemeral({ channel: payload.channel_id, user: payload.user_id, text: "Log1 could not process that command. Try again." }).catch(() => undefined);
      }
    });
  });

  const handleViewSubmission = async ({ ack, body }: SlackViewMiddlewareArgs<ViewSubmitAction>): Promise<void> => {
    const parsed = parseModalSubmission(body);
    if (!parsed.ok) {
      await ackModalError(ack, parsed.error.message);
      return;
    }
    await ack();
    const identity = modalIdentity(body);
    if (identity === undefined || identity.workspaceId !== workspaceId) return;
    const actorToken = await Promise.resolve(authResolver({ workspaceId: identity.workspaceId, userId: identity.userId })).catch(() => undefined);
    const actor = actorToken === undefined || actorToken.trim().length === 0
      ? unauthenticatedActor()
      : authenticatedActor({ actorId: identity.userId, workspaceId: identity.workspaceId, accessToken: actorToken });
    const command = { ...parsed.value, actor };
    const result = command.kind === "update_submission" ? await updateService.execute(command) : await feedbackService.execute(command);
    const origin = parseModalOrigin(body);
    if (origin === undefined || origin.workspaceId !== identity.workspaceId || origin.userId !== identity.userId || origin.channelId.length === 0) return;
    let text: string;
    if (!result.ok) text = describeLog1Error(result.error);
    else if ("candidateName" in result.value) text = `Updated ${result.value.candidateName}'s submission in Log1.`;
    else text = `Recorded interview feedback for ${result.value.submission.candidateName}.`;
    await (app.client as unknown as SlackApiClient).chat.postEphemeral({ channel: origin.channelId, user: origin.userId, text }).catch(() => undefined);
  };

  app.view("log1_update_submission", handleViewSubmission);
  app.view("log1_feedback", handleViewSubmission);
  return app;
};

export const startSocketModeServer = async (): Promise<App> => {
  const app = createSocketModeApp();
  await app.init();
  await app.start();
  process.stdout.write("Log1 Slack Socket Mode app connected.\n");
  return app;
};

if (require.main === module) {
  void startSocketModeServer().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Log1 Slack Socket Mode startup failed."}\n`);
    process.exitCode = 1;
  });
}
