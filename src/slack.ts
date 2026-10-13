import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  type ActorContext,
  type CommandId,
  type Log1Error,
  type RecordFeedbackCommand,
  type Result,
  type SubmissionSnapshot,
  type SubmissionChange,
  type SubmissionStatus,
  type UpdateSubmissionCommand,
  commandId,
  err,
  isFeedbackRecommendation,
  isScore,
  isSubmissionStatus,
  interviewId,
  ok,
  submissionId,
  unauthenticatedActor,
} from "./domain";
import { describeLog1Error } from "./services";
import type { Log1Port } from "./domain";

/** The fields Slack sends for a slash command. The parser adds the discriminant. */
export type SlackSlashPayload = {
  readonly type: "slash_command";
  readonly command: string;
  readonly text: string;
  readonly user_id: string;
  readonly team_id: string;
  readonly trigger_id?: string;
  readonly channel_id?: string;
};
type SlashRoutePayload = Omit<SlackSlashPayload, "type"> & { readonly type?: "slash_command" };

type SlackText = { readonly type: "plain_text"; readonly text: string; readonly emoji?: boolean };
type SlackOption = { readonly text: SlackText; readonly value: string };
type SlackElement =
  | {
      readonly type: "plain_text_input";
      readonly action_id: string;
      readonly multiline?: boolean;
      readonly initial_value?: string;
    }
  | {
      readonly type: "static_select";
      readonly action_id: string;
      readonly options: readonly SlackOption[];
      readonly initial_option?: SlackOption;
    }
  | {
      readonly type: "multi_static_select";
      readonly action_id: string;
      readonly options: readonly SlackOption[];
      readonly initial_options?: readonly SlackOption[];
    };
type SlackBlock =
  | { readonly type: "section"; readonly text: { readonly type: "mrkdwn"; readonly text: string } }
  | { readonly type: "context"; readonly elements: readonly { readonly type: "mrkdwn"; readonly text: string }[] }
  | {
      readonly type: "input";
      readonly block_id: string;
      readonly label: SlackText;
      readonly element: SlackElement;
      readonly optional?: boolean;
    };

export type SlackModal = {
  readonly type: "modal";
  readonly callback_id: "log1_update_submission" | "log1_feedback";
  readonly title: SlackText;
  readonly submit: SlackText;
  readonly close: SlackText;
  readonly private_metadata: string;
  readonly blocks: readonly SlackBlock[];
};

export type SlackResponse = {
  readonly response_type: "ephemeral";
  readonly text: string;
  readonly view?: SlackModal;
};

export type SlackViewSubmissionPayload = {
  readonly type: "view_submission";
  readonly user: { readonly id: string };
  readonly team: { readonly id: string };
  readonly view: UnknownRecord;
  readonly response_url?: string;
};

export type SlackBoundaryPayload =
  | (SlackSlashPayload & { readonly type: "slash_command" })
  | SlackViewSubmissionPayload;

export type ViewsOpenInput = { readonly workspaceId: string; readonly triggerId: string; readonly view: SlackModal };
export type PostEphemeralInput = {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly text: string;
  readonly responseUrl?: string;
};

/** The only Slack calls the application needs. Implement this with the Slack Web API in production. */
export interface SlackApi {
  viewsOpen(input: ViewsOpenInput): Promise<void>;
  postEphemeral(input: PostEphemeralInput): Promise<void>;
}

export const noopSlackApi: SlackApi = {
  async viewsOpen(): Promise<void> {},
  async postEphemeral(): Promise<void> {},
};

export type SlackBotTokenResolver = (workspaceId: string) => string | undefined | Promise<string | undefined>;

export const createSlackWebApi = (
  resolveBotToken: SlackBotTokenResolver,
  apiBaseUrl = "https://slack.com/api",
): SlackApi => {
  const call = async (workspaceId: string, method: string, body: Record<string, unknown>): Promise<void> => {
    const token = await resolveBotToken(workspaceId);
    if (token === undefined || token.trim().length === 0) throw new Error("Slack bot token is not configured for this workspace.");
    const response = await fetch(`${apiBaseUrl}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.ok !== true) {
      const error = isRecord(payload) && typeof payload.error === "string" ? payload.error : "unknown_error";
      throw new Error(`Slack API ${method} failed: ${error}.`);
    }
  };
  return {
    viewsOpen: (input) => call(input.workspaceId, "views.open", { trigger_id: input.triggerId, view: input.view }),
    postEphemeral: (input) => call(input.workspaceId, "chat.postEphemeral", { channel: input.channelId, user: input.userId, text: input.text }),
  };
};

const usageText = "Usage: /log1 help | /log1 update [candidate] | /log1 feedback [candidate]";

const plainText = (text: string): SlackText => ({ type: "plain_text", text, emoji: true });
const option = (value: string, label: string): SlackOption => ({ text: plainText(label), value });

const statuses: readonly SubmissionStatus[] = ["new", "screening", "onsite", "offer", "hired", "rejected", "withdrawn"];
const recommendations = ["strong_yes", "yes", "mixed", "no", "strong_no"] as const;
const yesNoOptions = [option("yes", "Yes"), option("no", "No")];
const liveStrengthOptions = [
  "Coding on time",
  "Proper resume",
  "Good Mimicking",
  "Complete details from Marketer",
  "None",
].map((label) => option(label, label));
const liveConcernOptions = [
  "Coding Error",
  "Resume Justification Issue",
  "Selective Client Requirements",
  "Technical Difficulties",
  "Skill Limitations",
  "Supervisor-Coder Misalignment",
  "Incomplete Marketing Information",
  "Mimicking Challenges",
  "Pre-Call Information Not Received",
  "Interviewer Conduct Issue",
  "Senior-Level Role Complexity",
  "JD-Candidate Profile Mismatch",
  "Consultant's Technical Issues",
  "Client's Technical Difficulties",
  "Resume-Skill Mismatch",
  "On-site Interview Request",
  "Interview No-Show",
  "Coding System Incompatibility",
  "Specific SQL Server Requirement",
  "Incomplete Coding Assessment",
  "Lack of System Setup for Coding",
  "The vendor works with consultants directly",
  "Network issue on consultant's end",
  "Interviewer was suspicious",
  "incompatible interview platform to join",
  "We were not able to code",
  "None",
].map((label) => option(label, label));

const isLiveSubmission = (candidate: SubmissionSnapshot): boolean =>
  candidate.modifiedAt !== undefined
  || candidate.client !== undefined
  || candidate.employer !== undefined
  || candidate.phone !== undefined
  || candidate.rate !== undefined
  || candidate.workType !== undefined
  || candidate.vendorContactId !== undefined;

const metadataFor = (
  kind: "update" | "feedback",
  candidate: SubmissionSnapshot,
  command: CommandId,
  interviewIdValue?: string,
  origin?: { readonly workspaceId: string; readonly userId: string; readonly channelId: string },
): string =>
  JSON.stringify(
    interviewIdValue === undefined
      ? { kind, form: isLiveSubmission(candidate) ? "live" : "legacy", commandId: command, submissionId: candidate.id, expectedVersion: candidate.version, ...(origin === undefined ? {} : { origin }) }
      : { kind, form: isLiveSubmission(candidate) ? "live" : "legacy", commandId: command, submissionId: candidate.id, interviewId: interviewIdValue, expectedVersion: candidate.version, ...(origin === undefined ? {} : { origin }) },
  );

export type ModalOrigin = { readonly workspaceId: string; readonly userId: string; readonly channelId: string };

/** Bind a modal to the Slack installation and channel that opened it. */
export const withModalOrigin = (view: SlackModal, origin: ModalOrigin): SlackModal => {
  let metadata: unknown;
  try {
    metadata = JSON.parse(view.private_metadata);
  } catch {
    throw new Error("Modal metadata is invalid.");
  }
  if (!isRecord(metadata)) throw new Error("Modal metadata must be an object.");
  return { ...view, private_metadata: JSON.stringify({ ...metadata, origin }) };
};

export const buildUpdateSubmissionModal = (candidate: SubmissionSnapshot, command: CommandId): SlackModal => {
  if (isLiveSubmission(candidate)) {
    return {
      type: "modal",
      callback_id: "log1_update_submission",
      title: plainText("Update submission"),
      submit: plainText("Save"),
      close: plainText("Cancel"),
      private_metadata: metadataFor("update", candidate, command),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${candidate.candidateName}*\n${candidate.role} · ${candidate.candidateEmail}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: `Log1 version ${candidate.version}` }] },
        liveTextInput("client_input", "Client", "client", candidate.client ?? ""),
        liveTextInput("rate_input", "Rate", "rate", candidate.rate === undefined ? "" : String(candidate.rate)),
        liveTextInput("employer_input", "Employer", "employer", candidate.employer ?? ""),
        liveTextInput("email_input", "Email", "email", candidate.candidateEmail),
        liveTextInput("phone_input", "Phone", "phone", candidate.phone ?? ""),
        liveTextInput("work_type_input", "Work type", "work_type", candidate.workType ?? ""),
      ],
    };
  }
  return {
    type: "modal",
    callback_id: "log1_update_submission",
    title: plainText("Update submission"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    private_metadata: metadataFor("update", candidate, command),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${candidate.candidateName}*\n${candidate.role} · ${candidate.candidateEmail}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Submission version ${candidate.version}` }] },
      {
        type: "input",
        block_id: "status_input",
        label: plainText("Status"),
        element: { type: "static_select", action_id: "status", options: statuses.map((status) => option(status, status)), initial_option: option(candidate.status, candidate.status) },
      },
      { type: "input", block_id: "note_input", label: plainText("Note"), element: { type: "plain_text_input", action_id: "note", multiline: true, initial_value: candidate.note } },
    ],
  };
};

const liveTextInput = (blockId: string, label: string, actionId: string, initialValue: string): SlackBlock => ({
  type: "input",
  block_id: blockId,
  label: plainText(label),
  element: { type: "plain_text_input", action_id: actionId, initial_value: initialValue },
});

export const buildFeedbackModal = (
  candidate: SubmissionSnapshot,
  interview: SubmissionSnapshot["interviews"][number],
  command: CommandId,
): SlackModal => {
  const isLive = isLiveSubmission(candidate);
  return {
    type: "modal",
    callback_id: "log1_feedback",
    title: plainText("Record interview feedback"),
    submit: plainText("Record feedback"),
    close: plainText("Cancel"),
    private_metadata: metadataFor("feedback", candidate, command, interview.id),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${candidate.candidateName}*\n${candidate.role}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Interview: ${interview.title} · ${interview.interviewer}` }] },
      {
        type: "input",
        block_id: "coding_input",
        label: plainText("Was coding involved in the call?"),
        element: { type: "static_select", action_id: "coding", options: yesNoOptions, initial_option: option("no", "No") },
      },
      {
        type: "input",
        block_id: "final_round_input",
        label: plainText("Is this the final round?"),
        element: { type: "static_select", action_id: "final_round", options: yesNoOptions, initial_option: option("no", "No") },
      },
      {
        type: "input",
        block_id: "recommendation_input",
        label: plainText("Recommendation"),
        element: {
          type: "static_select",
          action_id: "recommendation",
          options: recommendations.map((value) => option(value, value.replaceAll("_", " "))),
          ...(interview.feedback === null ? {} : { initial_option: option(interview.feedback.recommendation, interview.feedback.recommendation) }),
        },
      },
      {
        type: "input",
        block_id: "score_input",
        label: plainText("Score (1–5)"),
        element: {
          type: "static_select",
          action_id: "score",
          options: [1, 2, 3, 4, 5].map((score) => option(String(score), String(score))),
          ...(interview.feedback === null ? {} : { initial_option: option(String(interview.feedback.score), String(interview.feedback.score)) }),
        },
      },
      isLive
        ? multiFeedbackInput("strengths_input", "Strengths", "strengths", liveStrengthOptions, interview.feedback?.strengths)
        : feedbackInput("strengths_input", "Strengths", "strengths", interview.feedback?.strengths),
      isLive
        ? multiFeedbackInput("concerns_input", "Concerns", "concerns", liveConcernOptions, interview.feedback?.concerns)
        : feedbackInput("concerns_input", "Concerns", "concerns", interview.feedback?.concerns),
      feedbackInput("notes_input", "Notes", "notes", interview.feedback?.notes),
    ],
  };
};

const feedbackInput = (
  blockId: string,
  label: string,
  actionId: string,
  initialValue: string | undefined,
): SlackBlock => ({
  type: "input",
  block_id: blockId,
  label: plainText(label),
  optional: true,
  element:
    initialValue === undefined
      ? { type: "plain_text_input", action_id: actionId, multiline: true }
      : { type: "plain_text_input", action_id: actionId, multiline: true, initial_value: initialValue },
});

const initialOptionsFor = (value: string | undefined, options: readonly SlackOption[]): readonly SlackOption[] => {
  if (value === undefined) return [];
  const byLabel = new Map(options.map((item) => [item.text.text, item]));
  const seen = new Set<string>();
  const selected: SlackOption[] = [];
  for (const label of value.split(",").map((part) => part.trim())) {
    const item = byLabel.get(label);
    if (item === undefined || seen.has(label)) continue;
    seen.add(label);
    selected.push(item);
  }
  return selected;
};

const multiFeedbackInput = (
  blockId: string,
  label: string,
  actionId: string,
  options: readonly SlackOption[],
  initialValue: string | undefined,
): SlackBlock => {
  const initialOptions = initialOptionsFor(initialValue, options);
  return {
    type: "input",
    block_id: blockId,
    label: plainText(label),
    optional: true,
    element: {
      type: "multi_static_select",
      action_id: actionId,
      options,
      ...(initialOptions.length === 0 ? {} : { initial_options: initialOptions }),
    },
  };
};

export const makeStableCommandId = (seed: string): CommandId => {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return commandId(`slack-${digest}`);
};

export const verifySlackSignature = (
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  signingSecret: string,
  nowMs = Date.now(),
  toleranceSeconds = 300,
): boolean => {
  if (timestampHeader === undefined || signatureHeader === undefined || signingSecret.length === 0) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp) || Math.abs(Math.floor(nowMs / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(signatureHeader, "utf8");
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
};

/** Route a parsed command for local use and tests. HTTP transport uses runSlashCommand in the background. */
export async function routeSlashCommand(input: {
  readonly payload: SlashRoutePayload;
  readonly actor: ActorContext;
  readonly port: Log1Port;
  readonly commandId: CommandId;
}): Promise<SlackResponse> {
  if (input.payload.command !== "/log1") return { response_type: "ephemeral", text: usageText };
  const [subcommand = "help", ...queryParts] = input.payload.text.trim().split(/\s+/).filter(Boolean);
  if (subcommand === "help") return { response_type: "ephemeral", text: usageText };
  if (subcommand !== "update" && subcommand !== "feedback") return { response_type: "ephemeral", text: usageText };

  const query = queryParts.join(" ");
  const found = await input.port.findSubmissions(input.actor, query, { includeInterviews: false });
  if (!found.ok) return { response_type: "ephemeral", text: describeLog1Error(found.error) };
  const candidate = found.value[0];
  if (candidate === undefined) {
    return { response_type: "ephemeral", text: query.length === 0 ? "No submissions are available." : `No submission matched “${query}”.` };
  }
  if (subcommand === "update") {
    // The submission search result already contains every field needed to
    // render the update form. Defer the authoritative detail read until the
    // user submits, so Slack's short slash-command trigger window is not spent
    // on a second network round trip.
    return { response_type: "ephemeral", text: `Opening an update form for ${candidate.candidateName}.`, view: buildUpdateSubmissionModal(candidate, input.commandId) };
  }
  const detail = await input.port.getSubmission(input.actor, candidate.id, { includeInterviews: true });
  if (!detail.ok) return { response_type: "ephemeral", text: describeLog1Error(detail.error) };
  const fullCandidate = detail.value;
  const interview = fullCandidate.interviews.find((item) => item.status === "completed" && item.feedback === null);
  if (interview === undefined) return { response_type: "ephemeral", text: `No completed interview is available for ${candidate.candidateName}.` };
  return { response_type: "ephemeral", text: `Opening a feedback form for ${fullCandidate.candidateName}.`, view: buildFeedbackModal(fullCandidate, interview, input.commandId) };
}

export async function runSlashCommand(input: {
  readonly payload: SlackSlashPayload;
  readonly actor: ActorContext;
  readonly port: Log1Port;
  readonly commandId: CommandId;
  readonly slackApi: SlackApi;
  readonly lookupTimeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.lookupTimeoutMs ?? 2_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<SlackResponse>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("LOG1_LOOKUP_TIMEOUT")), timeoutMs);
  });
  let result: SlackResponse;
  try {
    result = await Promise.race([routeSlashCommand(input), timeoutPromise]);
  } catch {
    if (input.payload.channel_id !== undefined && input.payload.channel_id.length > 0) {
      await input.slackApi.postEphemeral({
        workspaceId: input.payload.team_id,
        channelId: input.payload.channel_id,
        userId: input.payload.user_id,
        text: "Log1 took too long to find that submission. Try the command again.",
      });
    }
    return;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const destination = input.payload.channel_id === undefined || input.payload.channel_id.length === 0
    ? undefined
    : { channelId: input.payload.channel_id, userId: input.payload.user_id };
  if (result.view !== undefined) {
    const triggerId = input.payload.trigger_id;
    if (triggerId === undefined || triggerId.length === 0) {
      if (destination !== undefined) await input.slackApi.postEphemeral({ ...destination, workspaceId: input.payload.team_id, text: "Slack did not provide a trigger ID, so the form could not be opened." });
      return;
    }
    try {
      await input.slackApi.viewsOpen({
        workspaceId: input.payload.team_id,
        triggerId,
        view: withModalOrigin(result.view, {
          workspaceId: input.payload.team_id,
          userId: input.payload.user_id,
          channelId: input.payload.channel_id ?? "",
        }),
      });
      if (destination !== undefined) await input.slackApi.postEphemeral({ ...destination, workspaceId: input.payload.team_id, text: result.text });
    } catch {
      if (destination !== undefined) {
        await input.slackApi.postEphemeral({ ...destination, workspaceId: input.payload.team_id, text: "Log1 found the candidate, but Slack could not open the form. Try the command again." });
      }
    }
    return;
  }
  if (destination !== undefined) await input.slackApi.postEphemeral({ ...destination, workspaceId: input.payload.team_id, text: result.text });
}

type UnknownRecord = { readonly [key: string]: unknown };
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null;
const readString = (record: UnknownRecord, key: string): string | undefined => typeof record[key] === "string" ? record[key] : undefined;
const readRecord = (record: UnknownRecord, key: string): UnknownRecord | undefined => isRecord(record[key]) ? record[key] : undefined;
const exactKeys = (record: UnknownRecord, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
};

const invalidModal = (message: string, field?: string): Result<never, Log1Error> =>
  field === undefined ? err({ kind: "validation", message }) : err({ kind: "validation", message, field });
const metadataId = (metadata: UnknownRecord, key: string): string | undefined => {
  const value = readString(metadata, key)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};
const parseMetadata = (raw: string): Result<UnknownRecord, Log1Error> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? ok(parsed) : invalidModal("Modal metadata must be an object.");
  } catch {
    return invalidModal("Modal metadata is invalid.");
  }
};
const parseExpectedVersion = (metadata: UnknownRecord): Result<number, Log1Error> => {
  const raw = metadata.expectedVersion;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? ok(raw) : invalidModal("Modal version is missing or invalid.", "expectedVersion");
};

type FormField = { readonly actionId: string; readonly type: "select" | "multi_select" | "text" };
type FormDefinition = { readonly kind: "update" | "feedback"; readonly form: "legacy" | "live"; readonly fields: Readonly<Record<string, FormField>> };

const formRegistry: Record<"log1_update_submission" | "log1_feedback", FormDefinition> = {
  log1_update_submission: {
    kind: "update",
    form: "legacy",
    fields: { status_input: { actionId: "status", type: "select" }, note_input: { actionId: "note", type: "text" } },
  },
  log1_feedback: {
    kind: "feedback",
    form: "legacy",
    fields: {
      coding_input: { actionId: "coding", type: "select" },
      final_round_input: { actionId: "final_round", type: "select" },
      recommendation_input: { actionId: "recommendation", type: "select" },
      score_input: { actionId: "score", type: "select" },
      strengths_input: { actionId: "strengths", type: "text" },
      concerns_input: { actionId: "concerns", type: "text" },
      notes_input: { actionId: "notes", type: "text" },
    },
  },
};
const liveUpdateFields: FormDefinition = {
  kind: "update",
  form: "live",
  fields: {
    client_input: { actionId: "client", type: "text" },
    rate_input: { actionId: "rate", type: "text" },
    employer_input: { actionId: "employer", type: "text" },
    email_input: { actionId: "email", type: "text" },
    phone_input: { actionId: "phone", type: "text" },
    work_type_input: { actionId: "work_type", type: "text" },
  },
};
const liveFeedbackFields: FormDefinition = {
  kind: "feedback",
  form: "live",
  fields: {
    coding_input: { actionId: "coding", type: "select" },
    final_round_input: { actionId: "final_round", type: "select" },
    recommendation_input: { actionId: "recommendation", type: "select" },
    score_input: { actionId: "score", type: "select" },
    strengths_input: { actionId: "strengths", type: "multi_select" },
    concerns_input: { actionId: "concerns", type: "multi_select" },
    notes_input: { actionId: "notes", type: "text" },
  },
};
type FormCallbackId = keyof typeof formRegistry;
const isFormCallbackId = (value: string): value is FormCallbackId => value === "log1_update_submission" || value === "log1_feedback";

const stateAction = (values: UnknownRecord, blockId: string, actionId: string, fieldType: FormField["type"]): Result<UnknownRecord, Log1Error> => {
  const block = readRecord(values, blockId);
  if (block === undefined || !exactKeys(block, [actionId])) return invalidModal(`Field ${blockId} is missing or has an unexpected action.`, blockId);
  const action = readRecord(block, actionId);
  if (action === undefined) return invalidModal(`Field ${blockId} is malformed.`, blockId);
  const declaredActionId = readString(action, "action_id");
  const declaredType = readString(action, "type");
  const expectedType = fieldType === "select" ? "static_select" : fieldType === "multi_select" ? "multi_static_select" : "plain_text_input";
  if (declaredActionId !== actionId || declaredType !== expectedType) {
    return invalidModal(`Field ${blockId} has an unexpected action type.`, blockId);
  }
  return ok(action);
};
const selectedValue = (action: UnknownRecord, blockId: string): Result<string, Log1Error> => {
  const selected = readRecord(action, "selected_option");
  const value = selected === undefined ? undefined : readString(selected, "value");
  return value === undefined ? invalidModal(`Choose a value for ${blockId}.`, blockId) : ok(value);
};
const selectedLabels = (action: UnknownRecord, blockId: string): Result<string, Log1Error> => {
  const selected = action.selected_options;
  if (!Array.isArray(selected)) return invalidModal(`Choose values for ${blockId}.`, blockId);
  const labels: string[] = [];
  for (const item of selected) {
    const selectedOption = isRecord(item) ? item : undefined;
    const text = selectedOption === undefined ? undefined : readRecord(selectedOption, "text");
    const label = text === undefined ? undefined : readString(text, "text");
    if (label === undefined) return invalidModal(`Field ${blockId} has malformed selected options.`, blockId);
    labels.push(label);
  }
  return ok(labels.join(", "));
};
const textValue = (action: UnknownRecord, blockId: string): Result<string, Log1Error> => {
  const value = readString(action, "value");
  return value === undefined ? invalidModal(`Enter a value for ${blockId}.`, blockId) : ok(value);
};

export type ModalCommand = UpdateSubmissionCommand | RecordFeedbackCommand;

export const parseModalSubmission = (payload: unknown, actor: ActorContext = unauthenticatedActor()): Result<ModalCommand, Log1Error> => {
  if (!isRecord(payload) || payload.type !== "view_submission") return invalidModal("Interaction payload must have type view_submission.");
  const user = readRecord(payload, "user");
  const team = readRecord(payload, "team");
  if (readString(user ?? {}, "id") === undefined || readString(team ?? {}, "id") === undefined) return invalidModal("Interaction payload is missing user or team identity.");
  const view = readRecord(payload, "view");
  if (view === undefined || view.type !== "modal") return invalidModal("Interaction payload must contain a modal view.");
  const callbackId = readString(view, "callback_id");
  if (callbackId === undefined || !isFormCallbackId(callbackId)) return invalidModal("Unsupported modal type.");
  const rawMetadata = readString(view, "private_metadata");
  const state = readRecord(view, "state");
  const values = state === undefined ? undefined : readRecord(state, "values");
  if (rawMetadata === undefined || values === undefined) return invalidModal("Modal metadata or state is missing.");
  const metadataResult = parseMetadata(rawMetadata);
  if (!metadataResult.ok) return metadataResult;
  const metadata = metadataResult.value;
  const metadataKind = metadataId(metadata, "kind");
  const metadataForm = metadataId(metadata, "form") ?? "legacy";
  const registry = metadataForm === "live"
    ? callbackId === "log1_update_submission" ? liveUpdateFields : liveFeedbackFields
    : formRegistry[callbackId];
  const command = metadataId(metadata, "commandId");
  const submission = metadataId(metadata, "submissionId");
  if (command === undefined || submission === undefined) return invalidModal("Modal command identifiers are missing.");
  const expectedVersion = parseExpectedVersion(metadata);
  if (!expectedVersion.ok) return expectedVersion;
  const fieldIds = Object.keys(registry.fields);
  if (!exactKeys(values, fieldIds)) return invalidModal("Modal fields do not match the form definition.");
  if (metadataKind !== registry.kind) return invalidModal(`Modal metadata does not match the ${registry.kind} form.`);

  const actions: Record<string, UnknownRecord> = {};
  for (const blockId of fieldIds) {
    const field = registry.fields[blockId];
    if (field === undefined) return invalidModal(`Field ${blockId} is not registered.`, blockId);
    const parsed = stateAction(values, blockId, field.actionId, field.type);
    if (!parsed.ok) return parsed;
    actions[blockId] = parsed.value;
  }
  if (registry.kind === "update") {
    if (registry.form === "live") {
      const client = textValue(actions.client_input ?? {}, "client_input");
      const rate = textValue(actions.rate_input ?? {}, "rate_input");
      const employer = textValue(actions.employer_input ?? {}, "employer_input");
      const email = textValue(actions.email_input ?? {}, "email_input");
      const phone = textValue(actions.phone_input ?? {}, "phone_input");
      const workType = textValue(actions.work_type_input ?? {}, "work_type_input");
      if (!client.ok || !rate.ok || !employer.ok || !email.ok || !phone.ok || !workType.ok) return invalidModal("Submission fields are malformed.");
      const parsedRate = Number(rate.value);
      if (!Number.isFinite(parsedRate) || parsedRate < 0) return invalidModal("Rate must be a non-negative number.", "rate");
      const changes: readonly [SubmissionChange, ...SubmissionChange[]] = [
        { kind: "client", client: client.value },
        { kind: "rate", rate: parsedRate },
        { kind: "employer", employer: employer.value },
        { kind: "email", email: email.value },
        { kind: "phone", phone: phone.value },
        { kind: "work_type", workType: workType.value },
      ];
      return ok({
        kind: "update_submission",
        commandId: commandId(command),
        actor,
        submissionId: submissionId(submission),
        expectedVersion: expectedVersion.value,
        changes,
        liveFields: {
          client: client.value,
          rate: parsedRate,
          employer: employer.value,
          email: email.value,
          phone: phone.value,
          workType: workType.value,
        },
      });
    }
    const statusAction = actions.status_input;
    const noteAction = actions.note_input;
    if (statusAction === undefined || noteAction === undefined) return invalidModal("Update fields are missing.");
    const statusValue = selectedValue(statusAction, "status_input");
    if (!statusValue.ok || !isSubmissionStatus(statusValue.value)) return invalidModal("Choose a valid submission status.", "status_input");
    const noteValue = textValue(noteAction, "note_input");
    if (!noteValue.ok) return noteValue;
    return ok({ kind: "update_submission", commandId: commandId(command), actor, submissionId: submissionId(submission), expectedVersion: expectedVersion.value, changes: [{ kind: "status", status: statusValue.value }, { kind: "note", note: noteValue.value }] });
  }
  const interview = metadataId(metadata, "interviewId");
  if (interview === undefined) return invalidModal("Interview identifier is missing.", "interviewId");
  const recommendationAction = actions.recommendation_input;
  const scoreAction = actions.score_input;
  const strengthsAction = actions.strengths_input;
  const concernsAction = actions.concerns_input;
  const notesAction = actions.notes_input;
  if (recommendationAction === undefined || scoreAction === undefined || strengthsAction === undefined || concernsAction === undefined || notesAction === undefined) return invalidModal("Feedback fields are missing.");
  const recommendationValue = selectedValue(recommendationAction, "recommendation_input");
  if (!recommendationValue.ok || !isFeedbackRecommendation(recommendationValue.value)) return invalidModal("Choose a valid recommendation.", "recommendation_input");
  const scoreValue = selectedValue(scoreAction, "score_input");
  const scoreNumber = scoreValue.ok ? Number(scoreValue.value) : Number.NaN;
  if (!isScore(scoreNumber)) return invalidModal("Choose a score from 1 to 5.", "score_input");
  const strengths = registry.form === "live" ? selectedLabels(strengthsAction, "strengths_input") : textValue(strengthsAction, "strengths_input");
  const concerns = registry.form === "live" ? selectedLabels(concernsAction, "concerns_input") : textValue(concernsAction, "concerns_input");
  const notes = textValue(notesAction, "notes_input");
  if (!strengths.ok || !concerns.ok || !notes.ok) return invalidModal("Feedback text fields are malformed.", !strengths.ok ? "strengths_input" : !concerns.ok ? "concerns_input" : "notes_input");
  const codingValue = selectedValue(actions.coding_input ?? {}, "coding_input");
  const finalRoundValue = selectedValue(actions.final_round_input ?? {}, "final_round_input");
  if (!codingValue.ok || !finalRoundValue.ok) return invalidModal("Choose whether coding was involved and whether this was the final round.", !codingValue.ok ? "coding_input" : "final_round_input");
  if ((codingValue.value !== "yes" && codingValue.value !== "no") || (finalRoundValue.value !== "yes" && finalRoundValue.value !== "no")) {
    return invalidModal("Choose a valid yes/no answer.", "coding_input");
  }
  return ok({ kind: "record_feedback", commandId: commandId(command), actor, submissionId: submissionId(submission), interviewId: interviewId(interview), expectedVersion: expectedVersion.value, recommendation: recommendationValue.value, score: scoreNumber, strengths: strengths.value, concerns: concerns.value, notes: notes.value, codingInvolved: codingValue.value === "yes", finalRound: finalRoundValue.value === "yes" });
};

export { describeLog1Error };
