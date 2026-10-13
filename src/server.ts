import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authenticatedActor, err, unauthenticatedActor, type ActorContext, type Log1Error, type Log1Port, type Result } from "./domain";
import { InMemoryLog1Port } from "./log1-port";
import { RealLog1Port } from "./real-log1-port";
import { FeedbackService, UpdateSubmissionService, describeLog1Error } from "./services";
import {
  makeStableCommandId,
  createSlackWebApi,
  noopSlackApi,
  parseModalSubmission,
  routeSlashCommand,
  runSlashCommand,
  type SlackApi,
  type SlackSlashPayload,
  verifySlackSignature,
} from "./slack";

export type AuthResolverInput = { readonly workspaceId: string; readonly userId: string };
export type AuthResolver = (input: AuthResolverInput) => string | undefined | Promise<string | undefined>;
export type ServerMode = "local" | "production";
export type WorkspaceTokenResolver = (workspaceId: string) => string | undefined | Promise<string | undefined>;
export type ServerOptions = {
  readonly mode?: ServerMode;
  readonly log1Port?: Log1Port;
  readonly signingSecret?: string;
  readonly actorToken?: string;
  readonly authResolver?: AuthResolver;
  readonly slackApi?: SlackApi;
  readonly maxBodyBytes?: number;
};

/**
 * Resolve a credential from an environment variable whose name is bound to a
 * Slack workspace. A single unscoped value is accepted only when its companion
 * `*_WORKSPACE_ID` value pins it to the requested workspace.
 *
 * This keeps a token for one Slack installation from being sent to another
 * installation when multiple workspaces share a process.
 */
export const createScopedEnvTokenResolver = (
  prefix: string,
  environment: NodeJS.ProcessEnv = process.env,
): WorkspaceTokenResolver => {
  const safePrefix = prefix.trim();
  return (workspaceId: string): string | undefined => {
    const normalizedWorkspaceId = workspaceId.trim();
    if (safePrefix.length === 0 || normalizedWorkspaceId.length === 0 || !/^[A-Za-z0-9_-]+$/.test(normalizedWorkspaceId)) return undefined;
    const scoped = environment[`${safePrefix}_${normalizedWorkspaceId}`];
    if (scoped !== undefined && scoped.trim().length > 0) return scoped.trim();
    const pinnedWorkspace = environment[`${safePrefix}_WORKSPACE_ID`]?.trim();
    const global = environment[safePrefix];
    return pinnedWorkspace === normalizedWorkspaceId && global !== undefined && global.trim().length > 0 ? global.trim() : undefined;
  };
};

const hasScopedEnvToken = (prefix: string, environment: NodeJS.ProcessEnv = process.env): boolean => {
  const pinned = environment[`${prefix}_WORKSPACE_ID`]?.trim();
  const global = environment[prefix];
  if (pinned !== undefined && pinned.length > 0 && global !== undefined && global.trim().length > 0) return true;
  return Object.keys(environment).some((key) => key.startsWith(`${prefix}_`) && key !== `${prefix}_WORKSPACE_ID` && (environment[key]?.trim().length ?? 0) > 0);
};

const unconfiguredPort: Log1Port = {
  async findSubmissions() { return err<Log1Error>({ kind: "temporarily_unavailable", message: "Log1 API is not configured." }); },
  async getSubmission() { return err<Log1Error>({ kind: "temporarily_unavailable", message: "Log1 API is not configured." }); },
  async updateSubmission() { return err<Log1Error>({ kind: "temporarily_unavailable", message: "Log1 API is not configured." }); },
  async recordFeedback() { return err<Log1Error>({ kind: "temporarily_unavailable", message: "Log1 API is not configured." }); },
};

type UnknownRecord = { readonly [key: string]: unknown };
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null;
const readString = (record: UnknownRecord, key: string): string | undefined => typeof record[key] === "string" ? record[key] : undefined;
const readRecord = (record: UnknownRecord, key: string): UnknownRecord | undefined => isRecord(record[key]) ? record[key] : undefined;
const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
const sendJson = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
};
const readBody = async (request: IncomingMessage, maxBodyBytes: number): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};
const parseSlashPayload = (body: string): Result<SlackSlashPayload, string> => {
  const params = new URLSearchParams(body);
  const command = params.get("command");
  const userId = params.get("user_id");
  const teamId = params.get("team_id");
  if (command === null || userId === null || teamId === null || userId.trim().length === 0 || teamId.trim().length === 0) {
    return { ok: false, error: "Slash command is missing command, user_id, or team_id." };
  }
  const triggerId = params.get("trigger_id") ?? undefined;
  const channelId = params.get("channel_id") ?? undefined;
  return {
    ok: true,
    value: {
      type: "slash_command",
      command,
      text: params.get("text") ?? "",
      user_id: userId,
      team_id: teamId,
      ...(triggerId === undefined ? {} : { trigger_id: triggerId }),
      ...(channelId === undefined ? {} : { channel_id: channelId }),
    },
  };
};
const parseInteractionPayload = (body: string): Result<unknown, string> => {
  const params = new URLSearchParams(body);
  const rawPayload = params.get("payload") ?? body;
  try {
    return { ok: true, value: JSON.parse(rawPayload) };
  } catch {
    return { ok: false, error: "Interaction payload is not valid JSON." };
  }
};
const parseInteractionIdentity = (payload: unknown): { userId: string; workspaceId: string } | undefined => {
  if (!isRecord(payload)) return undefined;
  const user = readRecord(payload, "user");
  const team = readRecord(payload, "team");
  const userId = readString(user ?? {}, "id");
  const workspaceId = readString(team ?? {}, "id");
  return userId === undefined || workspaceId === undefined || userId.length === 0 || workspaceId.length === 0 ? undefined : { userId, workspaceId };
};

export type ModalOrigin = {
  readonly workspaceId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly responseUrl?: string;
};

const boundedString = (record: UnknownRecord, key: string, maxLength = 512): string | undefined => {
  const value = readString(record, key)?.trim();
  return value === undefined || value.length === 0 || value.length > maxLength ? undefined : value;
};

/**
 * Read the slash-command destination carried through a modal's
 * `private_metadata`. Slack view submissions do not reliably include the
 * originating channel, so the metadata is the durable routing hint. The
 * workspace and user are checked against the signed interaction payload before
 * this destination is used.
 */
export const parseModalOrigin = (payload: unknown): ModalOrigin | undefined => {
  if (!isRecord(payload)) return undefined;
  const identity = parseInteractionIdentity(payload);
  if (identity === undefined) return undefined;
  const view = readRecord(payload, "view");
  const rawMetadata = readString(view ?? {}, "private_metadata");
  if (rawMetadata === undefined) return undefined;
  let metadata: UnknownRecord;
  try {
    const parsed: unknown = JSON.parse(rawMetadata);
    if (!isRecord(parsed)) return undefined;
    metadata = parsed;
  } catch {
    return undefined;
  }
  const origin = readRecord(metadata, "origin");
  if (origin === undefined) return undefined;
  const workspaceId = boundedString(origin, "workspaceId");
  const userId = boundedString(origin, "userId");
  const channelId = boundedString(origin, "channelId");
  if (workspaceId === undefined || userId === undefined || channelId === undefined) return undefined;
  if (workspaceId !== identity.workspaceId || userId !== identity.userId) return undefined;
  const responseUrl = boundedString(origin, "responseUrl", 4096);
  return responseUrl === undefined ? { workspaceId, userId, channelId } : { workspaceId, userId, channelId, responseUrl };
};

const interactionDestination = (payload: unknown, identity: { readonly userId: string; readonly workspaceId: string } | undefined): ModalOrigin | undefined => {
  if (identity === undefined || !isRecord(payload)) return undefined;
  const origin = parseModalOrigin(payload);
  if (origin !== undefined) return origin;
  const channel = readRecord(payload, "channel");
  const channelId = boundedString(channel ?? {}, "id");
  if (channelId === undefined) return undefined;
  const responseUrl = boundedString(payload, "response_url", 4096);
  return responseUrl === undefined
    ? { workspaceId: identity.workspaceId, userId: identity.userId, channelId }
    : { workspaceId: identity.workspaceId, userId: identity.userId, channelId, responseUrl };
};
const resolveActor = async (
  identity: { readonly userId: string; readonly workspaceId: string } | undefined,
  options: { readonly mode: ServerMode; readonly actorToken: string; readonly authResolver: AuthResolver | undefined },
): Promise<ActorContext> => {
  if (identity === undefined) return unauthenticatedActor();
  if (options.mode === "local") {
    try {
      return authenticatedActor({ actorId: identity.userId, workspaceId: identity.workspaceId, accessToken: options.actorToken });
    } catch {
      return unauthenticatedActor();
    }
  }
  if (options.authResolver === undefined) return unauthenticatedActor();
  try {
    const accessToken = await options.authResolver(identity);
    if (accessToken === undefined || accessToken.trim().length === 0) return unauthenticatedActor();
    return authenticatedActor({ actorId: identity.userId, workspaceId: identity.workspaceId, accessToken });
  } catch {
    return unauthenticatedActor();
  }
};
const successText = (commandKind: "update_submission" | "record_feedback", candidateName: string): string =>
  commandKind === "update_submission" ? `Updated ${candidateName}'s submission in Log1.` : `Recorded interview feedback for ${candidateName}.`;
const errorResponse = (error: { readonly message: string; readonly field?: string }): { response_action: "errors"; errors: Record<string, string> } => {
  const fieldMap: Record<string, string> = { status: "status_input", note: "note_input", client: "client_input", rate: "rate_input", employer: "employer_input", email: "email_input", phone: "phone_input", work_type: "work_type_input", coding: "coding_input", final_round: "final_round_input", recommendation: "recommendation_input", score: "score_input", strengths: "strengths_input", concerns: "concerns_input", notes: "notes_input", permission: "_form", interviewId: "_form", expectedVersion: "_form", commandId: "_form" };
  const blockId = error.field === undefined ? "_form" : fieldMap[error.field] ?? error.field;
  return { response_action: "errors", errors: { [blockId]: error.message } };
};

export const createServer = (options: ServerOptions = {}): Server => {
  const configuredMode = process.env.LOGGY_MODE;
  const mode: ServerMode = options.mode ?? (configuredMode === "local" ? "local" : "production");
  const signingSecret = options.signingSecret ?? process.env.SLACK_SIGNING_SECRET ?? "";
  // `actorToken` is deliberately local-only. Production credentials are
  // resolved per workspace below and never fall back to one global token.
  const actorToken = options.actorToken ?? (mode === "local" ? process.env.LOG1_ACTOR_TOKEN ?? "local-demo-token" : "");
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const slackTokenResolver = createScopedEnvTokenResolver("SLACK_BOT_TOKEN");
  const hasSlackBotToken = hasScopedEnvToken("SLACK_BOT_TOKEN");
  const slackApi = options.slackApi ?? (hasSlackBotToken ? createSlackWebApi(slackTokenResolver) : noopSlackApi);
  const envAuthResolver = createScopedEnvTokenResolver("LOG1_ACTOR_TOKEN");
  const hasActorCredential = options.authResolver !== undefined || hasScopedEnvToken("LOG1_ACTOR_TOKEN");
  const authResolver = options.authResolver ?? (hasActorCredential ? ((input: AuthResolverInput) => envAuthResolver(input.workspaceId)) : undefined);
  // In-memory data is a development fixture. Production requires an explicit
  // adapter so deployment cannot silently choose the wrong provider.
  const hasLog1Port = options.log1Port !== undefined;
  const port = options.log1Port ?? (mode === "local" ? new InMemoryLog1Port() : unconfiguredPort);
  const updateService = new UpdateSubmissionService(port);
  const feedbackService = new FeedbackService(port);
  const productionConfigured = mode === "local" || (signingSecret.length > 0 && hasActorCredential && hasLog1Port && (options.slackApi !== undefined || hasSlackBotToken));

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, productionConfigured ? 200 : 503, { ok: productionConfigured, mode, error: productionConfigured ? undefined : "Production mode requires SLACK_SIGNING_SECRET, a workspace-scoped Log1 credential resolver, a Log1 API port, and a SlackApi or workspace-scoped SLACK_BOT_TOKEN." });
      return;
    }
    if (request.method !== "POST" || (request.url !== "/slack/commands" && request.url !== "/slack/interactions")) {
      sendJson(response, 404, { ok: false, error: "Not found" });
      return;
    }
    if (!productionConfigured) {
      sendJson(response, 503, { ok: false, error: "Slack transport is not configured for production." });
      return;
    }
    let body: string;
    try {
      body = await readBody(request, maxBodyBytes);
    } catch (error) {
      sendJson(response, error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, error: "Request body could not be read." });
      return;
    }
    if (mode === "production" && !verifySlackSignature(body, header(request, "x-slack-request-timestamp"), header(request, "x-slack-signature"), signingSecret)) {
      sendJson(response, 401, { ok: false, error: "Invalid Slack signature." });
      return;
    }

    if (request.url === "/slack/commands") {
      const parsed = parseSlashPayload(body);
      if (!parsed.ok) {
        sendJson(response, 400, { ok: false, error: parsed.error });
        return;
      }
      const subcommand = parsed.value.text.trim().split(/\s+/, 1)[0] ?? "help";
      if ((subcommand === "update" || subcommand === "feedback") && (parsed.value.trigger_id === undefined || parsed.value.channel_id === undefined)) {
        sendJson(response, 400, { ok: false, error: "Interactive Log1 commands require Slack trigger_id and channel_id." });
        return;
      }
      const seed = parsed.value.trigger_id ?? `${parsed.value.user_id}:${parsed.value.command}:${parsed.value.text}`;
      sendJson(response, 200, { response_type: "ephemeral", text: "Working on that in Log1…" });
      void (async () => {
        const actor = await resolveActor({ userId: parsed.value.user_id, workspaceId: parsed.value.team_id }, { mode, actorToken, authResolver });
        await runSlashCommand({ payload: parsed.value, actor, port, commandId: makeStableCommandId(`slash:${seed}`), slackApi });
      })().catch(() => {
        process.stderr.write("log1 Slack command background task failed\n");
      });
      return;
    }

    const interaction = parseInteractionPayload(body);
    if (!interaction.ok) {
      sendJson(response, 400, { ok: false, error: interaction.error });
      return;
    }
    const parsedCommand = parseModalSubmission(interaction.value);
    if (!parsedCommand.ok) {
      sendJson(response, 200, errorResponse(parsedCommand.error));
      return;
    }
    sendJson(response, 200, { response_action: "clear" });
    void (async () => {
      const identity = parseInteractionIdentity(interaction.value);
      const actor = await resolveActor(identity, { mode, actorToken, authResolver });
      const command = { ...parsedCommand.value, actor };
      const result = command.kind === "update_submission" ? await updateService.execute(command) : await feedbackService.execute(command);
      const payload = interaction.value;
      const destination = interactionDestination(payload, identity);
      if (destination !== undefined) {
        const text = result.ok
          ? successText(command.kind, "candidateName" in result.value ? result.value.candidateName : result.value.submission.candidateName)
          : describeLog1Error(result.error);
        await slackApi.postEphemeral({ workspaceId: destination.workspaceId, channelId: destination.channelId, userId: destination.userId, text, ...(destination.responseUrl === undefined ? {} : { responseUrl: destination.responseUrl }) });
      }
    })().catch(() => {
      process.stderr.write("log1 Slack interaction background task failed\n");
    });
  };
  return createHttpServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "Unexpected server error." });
      else response.end();
    });
  });
};

export const startServer = (port = Number(process.env.PORT ?? "3000")): Server => {
  const mode: ServerMode = process.env.LOGGY_MODE === "local" ? "local" : "production";
  const server = createServer({
    mode,
    ...(mode === "production" ? { log1Port: new RealLog1Port() } : {}),
  });
  server.listen(port, () => process.stdout.write(`log1 Slack MVP listening on http://localhost:${port}\n`));
  return server;
};

if (require.main === module) startServer();
