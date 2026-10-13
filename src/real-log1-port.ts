import {
  err,
  interviewId,
  isFeedbackRecommendation,
  isScore,
  isSubmissionStatus,
  ok,
  submissionId,
  type ActorContext,
  type FeedbackRecordResult,
  type FeedbackSnapshot,
  type InterviewSnapshot,
  type InterviewStatus,
  type LiveSubmissionFields,
  type Log1Error,
  type Log1Port,
  type RecordFeedbackCommand,
  type Result,
  type SubmissionChange,
  type SubmissionId,
  type SubmissionReadOptions,
  type SubmissionSnapshot,
  type UpdateSubmissionCommand,
} from "./domain";

type UnknownRecord = { readonly [key: string]: unknown };
type FetchLike = typeof fetch;

const API_ORIGIN = "https://api.log1.com";
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null;
const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const numberValue = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const recordValue = (record: UnknownRecord, key: string): UnknownRecord | undefined => isRecord(record[key]) ? record[key] : undefined;
const stringField = (record: UnknownRecord, key: string): string | undefined => stringValue(record[key]);
const numberField = (record: UnknownRecord, key: string): number | undefined => numberValue(record[key]);
const idValue = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
};
const workTypeForDomain = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  const labels: Record<string, string> = { full_time: "Full Time", part_time: "Part Time", contract: "Contract", contract_to_hire: "Contract to Hire" };
  return labels[normalized] ?? value;
};
const workTypeForApi = (value: string): string => workTypeForDomain(value);

const invalidUpstream = (message = "Log1 returned an unexpected response."): Log1Error => ({ kind: "temporarily_unavailable", message });
const authRequired = (): Log1Error => ({ kind: "auth_required", message: "A Log1 actor token is required for this operation." });
const notFound = (resource: "submission" | "interview", id: string): Log1Error => ({ kind: "not_found", resource, message: `${resource} ${id} was not found.` });
const validation = (message: string, field?: string): Log1Error => field === undefined ? { kind: "validation", message } : { kind: "validation", message, field };

const toVersion = (value: unknown): number => {
  const date = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isFinite(date) && date >= 0) return Math.floor(date / 1000);
  const numeric = numberValue(value);
  return numeric !== undefined && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
};

const toStatus = (value: unknown): Result<SubmissionSnapshot["status"], Log1Error> => {
  if (typeof value !== "string") return err(validation("Log1 submission status is missing."));
  const normalized = value.trim().toLowerCase();
  const mapped = normalized === "sub" ? "new"
    : normalized === "interview" ? "onsite"
      : normalized === "next_round" || normalized === "feedback_due" ? "onsite"
        : normalized === "project" ? "hired"
        : normalized === "in_offer" ? "offer"
          : normalized === "failed" || normalized === "cancelled" ? "rejected"
            : normalized;
  return isSubmissionStatus(mapped) ? ok(mapped) : err(validation("Log1 returned an unsupported submission status."));
};

const statusOfInterview = (value: unknown): InterviewStatus => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "completed" || normalized === "complete" || normalized === "passed" || normalized === "failed" || normalized === "next_round" || normalized === "feedback_due") return "completed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "scheduled";
};

const recommendationFrom = (value: unknown): FeedbackSnapshot["recommendation"] | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replace(/[ -]/g, "_");
  return isFeedbackRecommendation(normalized) ? normalized : undefined;
};

const ratingScoreFrom = (value: unknown): FeedbackSnapshot["score"] | undefined => {
  if (typeof value !== "string") return undefined;
  const rating = ["bad", "unsatisfied", "okay", "satisfied", "good"].indexOf(value.trim().toLowerCase());
  return rating < 0 ? undefined : (rating + 1) as FeedbackSnapshot["score"];
};

const feedbackFromSupervisorAnswers = (value: unknown, actor: ActorContext, submittedAt: string): FeedbackSnapshot | null => {
  if (actor.kind !== "authenticated") return null;
  if (!Array.isArray(value)) return null;
  let score: FeedbackSnapshot["score"] | undefined;
  let strengths = "";
  let concerns = "";
  let notes = "";
  let usableAnswers = 0;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const question = recordValue(item, "question_answer");
    if (question === undefined) continue;
    const questionIdValue = idValue(question.ques_id) ?? idValue(question.question_id);
    const questionId = questionIdValue === undefined ? undefined : Number(questionIdValue);
    const answer = stringValue(question.answer);
    if (questionId === undefined || answer === undefined || answer.trim().length === 0) continue;
    switch (questionId) {
      case 49: {
        const mappedScore = ratingScoreFrom(answer);
        if (mappedScore === undefined) continue;
        score = mappedScore;
        usableAnswers += 1;
        break;
      }
      case 47:
        strengths = answer;
        usableAnswers += 1;
        break;
      case 48:
        concerns = answer;
        usableAnswers += 1;
        break;
      case 50:
        notes = answer;
        usableAnswers += 1;
        break;
      case 44:
      case 55: {
        const yesNo = answer.trim().toLowerCase();
        if (yesNo !== "yes" && yesNo !== "no") continue;
        usableAnswers += 1;
        break;
      }
      default:
        break;
    }
  }
  if (usableAnswers === 0) return null;
  return {
    recommendation: "mixed",
    score: score ?? 3,
    strengths,
    concerns,
    notes,
    submittedBy: actor.actorId,
    submittedAt,
  };
};

const feedbackFrom = (value: unknown, actor: ActorContext, fallbackSubmittedAt = new Date(0).toISOString()): FeedbackSnapshot | null => {
  if (actor.kind !== "authenticated") return null;
  if (typeof value === "string") {
    const notes = value.trim();
    return notes.length === 0 ? null : { recommendation: "mixed", score: 3, strengths: "", concerns: "", notes, submittedBy: actor.actorId, submittedAt: fallbackSubmittedAt };
  }
  if (!isRecord(value)) return null;
  const recommendation = recommendationFrom(value.recommendation ?? value.recommendation_value);
  const score = numberValue(value.score);
  if (recommendation === undefined || score === undefined || !isScore(score)) return null;
  return {
    recommendation,
    score,
    strengths: stringValue(value.strengths) ?? stringValue(value.what_went_well) ?? "",
    concerns: stringValue(value.concerns) ?? stringValue(value.issues) ?? "",
    notes: stringValue(value.notes) ?? stringValue(value.feedback) ?? "",
    submittedBy: actor.actorId,
    submittedAt: stringValue(value.submitted_at) ?? stringValue(value.modified) ?? fallbackSubmittedAt,
  };
};

const interviewFrom = (raw: unknown, submission: SubmissionId, actor: ActorContext): Result<InterviewSnapshot, Log1Error> => {
  if (!isRecord(raw)) return err(invalidUpstream());
  const rawId = idValue(raw.id);
  if (rawId === undefined) return err(invalidUpstream("Log1 interview ID is missing."));
  const supervisor = raw.supervisor;
  const supervisorDetail = recordValue(raw, "supervisor_detail");
  const interviewers = raw.interviewers;
  const interviewer = typeof supervisor === "string"
    ? supervisor
    : isRecord(supervisor)
      ? stringField(supervisor, "name") ?? stringField(supervisor, "employee_name") ?? stringField(supervisor, "supervisor_name")
      : stringField(supervisorDetail ?? {}, "supervisor_name")
        ?? (Array.isArray(interviewers) && typeof interviewers[0] === "string" ? interviewers[0] : undefined);
  const schedule = stringField(raw, "start_time") ?? stringField(raw, "scheduled_at") ?? stringField(raw, "created") ?? new Date(0).toISOString();
  const submittedAt = stringField(raw, "modified") ?? stringField(raw, "created") ?? new Date(0).toISOString();
  const feedback = feedbackFromSupervisorAnswers(raw.supervisor_feedback, actor, submittedAt)
    ?? feedbackFrom(raw.feedback, actor, submittedAt)
    ?? feedbackFrom(raw.supervisor_feedback, actor, submittedAt);
  return ok({
    id: interviewId(String(rawId)),
    submissionId: submission,
    title: stringField(raw, "screening_type") ?? `Interview round ${String(numberField(raw, "round") ?? 1)}`,
    interviewer: interviewer ?? "Log1 interviewer",
    scheduledAt: schedule,
    status: statusOfInterview(raw.status),
    feedback,
  });
};

const submissionFrom = (raw: unknown, interviews: readonly InterviewSnapshot[] = []): Result<SubmissionSnapshot, Log1Error> => {
  if (!isRecord(raw)) return err(invalidUpstream());
  const rawId = idValue(raw.id);
  if (rawId === undefined) return err(invalidUpstream("Log1 submission ID is missing."));
  const lead = recordValue(raw, "lead");
  const status = toStatus(raw.status);
  if (!status.ok) return status;
  const consultant = recordValue(raw, "consultant") ?? recordValue(raw, "consultant_marketing");
  const candidateName = stringField(raw, "consultant_name") ?? stringField(raw, "candidate_name") ?? stringField(consultant ?? {}, "name") ?? "Unknown candidate";
  const updatedAt = stringField(raw, "modified") ?? stringField(raw, "updated_at") ?? stringField(lead ?? {}, "modified") ?? stringField(raw, "created") ?? new Date(0).toISOString();
  const vendorContact = raw.vendor_contact;
  const vendorContactId = numberValue(vendorContact) ?? numberField(recordValue(raw, "vendor_contact") ?? {}, "id");
  const client = stringField(raw, "client");
  const employer = stringField(raw, "employer");
  const phone = stringField(raw, "phone");
  const rate = numberField(raw, "rate");
  const workType = stringField(raw, "work_type");
  return ok({
    id: submissionId(String(rawId)),
    candidateName,
    candidateEmail: stringField(raw, "email") ?? "",
    role: stringField(raw, "job_title") ?? stringField(raw, "position_name") ?? stringField(lead ?? {}, "job_title") ?? "",
    status: status.value,
    note: "",
    version: toVersion(updatedAt),
    updatedAt,
    interviews,
    ...(client === undefined ? {} : { client }),
    ...(employer === undefined ? {} : { employer }),
    ...(phone === undefined ? {} : { phone }),
    ...(rate === undefined ? {} : { rate }),
    ...(workType === undefined ? {} : { workType: workTypeForDomain(workType) }),
    ...(vendorContactId === undefined ? {} : { vendorContactId }),
    modifiedAt: updatedAt,
  });
};

const responseData = (value: unknown): unknown => {
  if (!isRecord(value)) return undefined;
  return value.data;
};

const listData = (value: unknown): readonly unknown[] | undefined => {
  if (Array.isArray(value)) return value;
  const data = responseData(value);
  return Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.data) ? data.data : undefined;
};

const consultantNameFrom = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const nested = recordValue(value, "consultant") ?? recordValue(value, "consultant_marketing");
  return stringField(value, "canonical_name")
    ?? stringField(value, "consultant_name")
    ?? stringField(value, "consultant")
    ?? stringField(value, "consultant_marketing")
    ?? stringField(value, "full_name")
    ?? stringField(value, "name")
    ?? stringField(value, "label")
    ?? stringField(value, "value")
    ?? (nested === undefined ? undefined : consultantNameFrom(nested));
};

const submissionListPath = (filterJson: string, query?: string): string => {
  const queryPart = query === undefined ? "" : `&query=${encodeURIComponent(query.replace(/&/g, ":amp:"))}`;
  return `/api/submission/?page=1&page_size=10${queryPart}&filter_json=${encodeURIComponent(filterJson)}&sort_by=modified&filter_for=all`;
};

const liveFieldsFromChanges = (changes: readonly SubmissionChange[]): Result<LiveSubmissionFields, Log1Error> => {
  const fields: {
    client?: string;
    rate?: number;
    employer?: string;
    email?: string;
    phone?: string;
    workType?: string;
    vendorContactId?: number | null;
  } = {};
  for (const change of changes) {
    switch (change.kind) {
      case "client": fields.client = change.client; break;
      case "rate": fields.rate = change.rate; break;
      case "employer": fields.employer = change.employer; break;
      case "email": fields.email = change.email; break;
      case "phone": fields.phone = change.phone; break;
      case "work_type": fields.workType = change.workType; break;
      case "vendor_contact": fields.vendorContactId = change.vendorContactId; break;
      case "status":
      case "note":
        return err(validation("Log1 does not expose status or note updates through its submission API.", "changes"));
      default: {
        const exhaustive: never = change;
        return exhaustive;
      }
    }
  }
  return ok(fields);
};

const errorForStatus = (status: number, resource: "submission" | "interview", id?: string): Log1Error => {
  if (status === 401 || status === 403) return authRequired();
  if (status === 404) return notFound(resource, id ?? "requested");
  if (status === 409) return { kind: "conflict", expectedVersion: 0, currentVersion: 0, message: "Log1 rejected the update because the record changed." };
  if (status === 429) return { kind: "rate_limited", message: "Log1 is rate limiting requests. Wait a moment and try again." };
  return { kind: "temporarily_unavailable", message: "Log1 is temporarily unavailable. Try again later." };
};

const canUpdate = (value: unknown): boolean => isRecord(value) && recordValue(value, "permission")?.update === true;

export type RealLog1PortOptions = {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
};

export class RealLog1Port implements Log1Port {
  private readonly requestFetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: RealLog1PortOptions = {}) {
    this.requestFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request(actor: ActorContext, path: string, init: RequestInit = {}): Promise<Result<unknown, Log1Error>> {
    if (actor.kind !== "authenticated") return err(authRequired());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      headers.set("authorization", `Token ${actor.accessToken}`);
      const response = await this.requestFetch(new URL(path, API_ORIGIN), { ...init, headers, redirect: "error", signal: controller.signal });
      if (!response.ok) return err(errorForStatus(response.status, path.includes("interview") ? "interview" : "submission", path.match(/\/(\d+)(?:\/|$)/)?.[1]));
      if (response.status === 204) return ok(null);
      try {
        return ok(await response.json() as unknown);
      } catch {
        return err(invalidUpstream());
      }
    } catch (error) {
      return err({ kind: "temporarily_unavailable", message: error instanceof Error && error.name === "AbortError" ? "Log1 request timed out." : "Log1 is temporarily unavailable. Try again later." });
    } finally {
      clearTimeout(timer);
    }
  }

  private async interviewsFor(actor: ActorContext, submission: SubmissionSnapshot): Promise<Result<readonly InterviewSnapshot[], Log1Error>> {
    const response = await this.request(actor, `/api/v2/submission/${encodeURIComponent(String(submission.id))}/interviews/`);
    if (!response.ok) return response;
    const rows = listData(response.value);
    if (rows === undefined) return err(invalidUpstream("Log1 interview list shape is invalid."));
    const interviews: InterviewSnapshot[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const nestedSubmission = row.submission;
      const rowSubmissionId = idValue(isRecord(nestedSubmission) ? nestedSubmission.id : nestedSubmission);
      if (rowSubmissionId === undefined || String(rowSubmissionId) !== String(submission.id)) continue;
      const mapped = interviewFrom(row, submission.id, actor);
      if (!mapped.ok) return mapped;
      interviews.push(mapped.value);
    }
    return ok(interviews);
  }

  async findSubmissions(actor: ActorContext, query: string, options?: SubmissionReadOptions): Promise<Result<readonly SubmissionSnapshot[], Log1Error>> {
    const trimmedQuery = query.trim();
    let response = trimmedQuery.length === 0
      ? await this.request(actor, submissionListPath("{}", ""))
      : await this.request(actor, submissionListPath(JSON.stringify({ consultant: [trimmedQuery] })));
    if (!response.ok) return response;
    let rows = listData(response.value);
    if (rows === undefined) return err(invalidUpstream("Log1 submission list shape is invalid."));

    if (trimmedQuery.length > 0 && rows.length === 0) {
      const consultantResponse = await this.request(actor, `/api/consultant/?query=${encodeURIComponent(trimmedQuery.replace(/&/g, ":amp:"))}`);
      if (!consultantResponse.ok) return consultantResponse;
      const consultantRows = listData(consultantResponse.value);
      if (consultantRows === undefined) return err(invalidUpstream("Log1 consultant list shape is invalid."));
      const queryLower = trimmedQuery.toLowerCase();
      const consultantNames: string[] = [];
      for (const consultantRow of consultantRows) {
        const name = consultantNameFrom(consultantRow)?.trim();
        if (name === undefined || name.length === 0 || !name.toLowerCase().includes(queryLower) || consultantNames.includes(name)) continue;
        consultantNames.push(name);
      }
      if (consultantNames.length === 0) return ok([]);
      response = await this.request(actor, submissionListPath(JSON.stringify({ consultant: consultantNames })));
      if (!response.ok) return response;
      rows = listData(response.value);
      if (rows === undefined) return err(invalidUpstream("Log1 submission list shape is invalid."));
    }

    const output: SubmissionSnapshot[] = [];
    for (const row of rows) {
      const mapped = submissionFrom(row);
      if (!mapped.ok) return mapped;
      if (options?.includeInterviews === false) {
        output.push(mapped.value);
        continue;
      }
      const interviews = await this.interviewsFor(actor, mapped.value);
      if (!interviews.ok) return interviews;
      output.push({ ...mapped.value, interviews: interviews.value });
    }
    return ok(output);
  }

  async getSubmission(actor: ActorContext, id: SubmissionId, options?: SubmissionReadOptions): Promise<Result<SubmissionSnapshot, Log1Error>> {
    const response = await this.request(actor, `/api/v2/submission/${encodeURIComponent(String(id))}/`);
    if (!response.ok) return err(response.error);
    const raw = responseData(response.value);
    const mapped = submissionFrom(raw);
    if (!mapped.ok) return mapped;
    if (options?.includeInterviews === false) return mapped;
    const interviews = await this.interviewsFor(actor, mapped.value);
    return interviews.ok ? ok({ ...mapped.value, interviews: interviews.value }) : interviews;
  }

  async updateSubmission(command: UpdateSubmissionCommand): Promise<Result<SubmissionSnapshot, Log1Error>> {
    if (command.actor.kind !== "authenticated") return err(authRequired());
    const numericId = Number(String(command.submissionId));
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return err(validation("Log1 submission ID is invalid.", "submissionId"));
    const current = await this.getSubmission(command.actor, command.submissionId);
    if (!current.ok) return current;
    if (current.value.version !== command.expectedVersion) return err({ kind: "conflict", expectedVersion: command.expectedVersion, currentVersion: current.value.version, message: "The submission changed in Log1; re-open the modal and try again." });
    const detailResponse = await this.request(command.actor, `/api/v2/submission/${encodeURIComponent(String(command.submissionId))}/`);
    if (!detailResponse.ok) return err(detailResponse.error);
    const permission = isRecord(detailResponse.value) ? recordValue(detailResponse.value, "permission") : undefined;
    if (permission === undefined || permission.update !== true) return err(validation("You do not have permission to update this submission.", "permission"));
    const raw = responseData(detailResponse.value);
    if (!isRecord(raw)) return err(invalidUpstream());
    const detailSubmission = submissionFrom(raw);
    if (!detailSubmission.ok) return detailSubmission;
    if (detailSubmission.value.version !== command.expectedVersion) return err({ kind: "conflict", expectedVersion: command.expectedVersion, currentVersion: detailSubmission.value.version, message: "The submission changed in Log1; re-open the modal and try again." });
    const vendor = recordValue(raw, "vendor_contact");
    const fromChanges = liveFieldsFromChanges(command.changes);
    if (!fromChanges.ok) return fromChanges;
    const fields: LiveSubmissionFields = { ...fromChanges.value, ...(command.liveFields ?? {}) };
    const currentWorkType = stringField(raw, "work_type") ?? "";
    const body = {
      sub_id: numericId,
      client: fields.client ?? stringField(raw, "client") ?? "",
      rate: fields.rate ?? numberField(raw, "rate") ?? 0,
      employer: fields.employer ?? stringField(raw, "employer") ?? "",
      email: fields.email ?? stringField(raw, "email") ?? "",
      phone: fields.phone ?? stringField(raw, "phone") ?? "",
      work_type: workTypeForApi(fields.workType ?? currentWorkType),
      // `null` is a meaningful explicit value here: it clears an existing
      // vendor contact instead of falling back to the value from the detail
      // response. Use property presence rather than nullish coalescing.
      vendor_contact_id: Object.prototype.hasOwnProperty.call(fields, "vendorContactId")
        ? fields.vendorContactId ?? null
        : numberField(vendor ?? {}, "id") ?? null,
    };
    const response = await this.request(command.actor, `/api/submission/${encodeURIComponent(String(command.submissionId))}/`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) return err(response.error);
    const refreshed = await this.getSubmission(command.actor, command.submissionId);
    if (refreshed.ok) return refreshed;
    return ok({
      ...current.value,
      ...(fields.client === undefined ? {} : { client: fields.client }),
      ...(fields.employer === undefined ? {} : { employer: fields.employer }),
      ...(fields.email === undefined ? {} : { candidateEmail: fields.email }),
      ...(fields.phone === undefined ? {} : { phone: fields.phone }),
      ...(fields.rate === undefined ? {} : { rate: fields.rate }),
      ...(fields.workType === undefined ? {} : { workType: workTypeForDomain(fields.workType) }),
      ...(fields.vendorContactId === undefined ? {} : { vendorContactId: fields.vendorContactId }),
    });
  }

  async recordFeedback(command: RecordFeedbackCommand): Promise<Result<FeedbackRecordResult, Log1Error>> {
    if (command.actor.kind !== "authenticated") return err(authRequired());
    const current = await this.getSubmission(command.actor, command.submissionId);
    if (!current.ok) return current;
    if (current.value.version !== command.expectedVersion) return err({ kind: "conflict", expectedVersion: command.expectedVersion, currentVersion: current.value.version, message: "The submission changed in Log1; re-open the modal and try again." });
    const interview = current.value.interviews.find((item) => item.id === command.interviewId);
    if (interview === undefined) return err(notFound("interview", String(command.interviewId)));
    if (interview.status !== "completed") return err(validation("Feedback can only be recorded for a completed interview.", "interviewId"));
    const detail = await this.request(command.actor, `/api/v2/submission/${encodeURIComponent(String(command.submissionId))}/`);
    if (!detail.ok) return err(detail.error);
    if (!canUpdate(detail.value)) return err(validation("You do not have permission to record feedback for this submission.", "permission"));
    const detailRaw = responseData(detail.value);
    const detailSubmission = submissionFrom(detailRaw);
    if (!detailSubmission.ok) return detailSubmission;
    if (detailSubmission.value.version !== command.expectedVersion) return err({ kind: "conflict", expectedVersion: command.expectedVersion, currentVersion: detailSubmission.value.version, message: "The submission changed in Log1; re-open the modal and try again." });
    const interviewDetail = await this.request(command.actor, `/api/interview/${encodeURIComponent(String(command.interviewId))}/`);
    if (!interviewDetail.ok) return err(interviewDetail.error);
    if (!canUpdate(interviewDetail.value)) return err(validation("You do not have permission to record feedback for this interview.", "permission"));
    const mappedInterview = interviewFrom(responseData(interviewDetail.value), command.submissionId, command.actor);
    if (!mappedInterview.ok) return mappedInterview;
    if (mappedInterview.value.status !== "completed") return err(validation("Feedback can only be recorded for a completed interview.", "interviewId"));
    const strengths = command.strengths.trim();
    const concerns = command.concerns.trim();
    const notes = command.notes.trim();
    if (strengths.length === 0 && concerns.length === 0) return err(validation("Enter what went well or any issues from the call.", "strengths"));
    if (notes.length === 0) return err(validation("Enter a remark for this interview.", "notes"));
    const form = new FormData();
    const rating = ["Bad", "Unsatisfied", "Okay", "Satisfied", "Good"][command.score - 1] ?? "Okay";
    form.append("feedback_form", JSON.stringify([
      { question_id: 44, que_value: "Was coding involved in call", answer: command.codingInvolved === true ? "Yes" : "No" },
      { question_id: 55, que_value: "Is it a final round", answer: command.finalRound === true ? "Yes" : "No" },
      { question_id: 49, que_value: "Overall Call Rating", answer: rating },
      { question_id: 47, que_value: "What went well in call", answer: strengths },
      { question_id: 48, que_value: "Issues faced during call", answer: concerns },
      { question_id: 50, que_value: "Remark", answer: notes },
    ]));
    const response = await this.request(command.actor, `/api/interview/${encodeURIComponent(String(command.interviewId))}/supervisor_feedback/`, { method: "POST", body: form });
    if (!response.ok) return err(response.error);
    const refreshed = await this.getSubmission(command.actor, command.submissionId);
    if (!refreshed.ok) return ok({ submission: current.value, interview: { ...interview, feedback: { recommendation: command.recommendation, score: command.score, strengths, concerns, notes, submittedBy: command.actor.actorId, submittedAt: new Date().toISOString() } } });
    const refreshedInterview = refreshed.value.interviews.find((item) => item.id === command.interviewId) ?? {
      ...interview,
      feedback: { recommendation: command.recommendation, score: command.score, strengths, concerns, notes, submittedBy: command.actor.actorId, submittedAt: new Date().toISOString() },
    };
    return ok({ submission: refreshed.value, interview: refreshedInterview });
  }
}

