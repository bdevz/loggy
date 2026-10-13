export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SubmissionId = Brand<string, "SubmissionId">;
export type InterviewId = Brand<string, "InterviewId">;
export type ActorId = Brand<string, "ActorId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type CommandId = Brand<string, "CommandId">;

export type SubmissionStatus =
  | "new"
  | "screening"
  | "onsite"
  | "offer"
  | "hired"
  | "rejected"
  | "withdrawn";

export type FeedbackRecommendation = "strong_yes" | "yes" | "mixed" | "no" | "strong_no";
export type Score = 1 | 2 | 3 | 4 | 5;
export type InterviewStatus = "scheduled" | "completed" | "cancelled";

export type ActorContext =
  | {
      readonly kind: "authenticated";
      readonly actorId: ActorId;
      readonly workspaceId: WorkspaceId;
      readonly accessToken: string;
    }
  | {
      readonly kind: "unauthenticated";
    };

export type FeedbackSnapshot = {
  readonly recommendation: FeedbackRecommendation;
  readonly score: Score;
  readonly strengths: string;
  readonly concerns: string;
  readonly notes: string;
  readonly submittedBy: ActorId;
  readonly submittedAt: string;
};

export type InterviewSnapshot = {
  readonly id: InterviewId;
  readonly submissionId: SubmissionId;
  readonly title: string;
  readonly interviewer: string;
  readonly scheduledAt: string;
  readonly status: InterviewStatus;
  readonly feedback: FeedbackSnapshot | null;
};

export type SubmissionSnapshot = {
  readonly id: SubmissionId;
  readonly candidateName: string;
  readonly candidateEmail: string;
  readonly role: string;
  readonly status: SubmissionStatus;
  readonly note: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly interviews: readonly InterviewSnapshot[];
  /** Fields Log1 accepts on its submission update endpoint. They are absent on the local fixture. */
  readonly client?: string;
  readonly employer?: string;
  readonly phone?: string;
  readonly rate?: number;
  readonly workType?: string;
  readonly vendorContactId?: number | null;
  readonly modifiedAt?: string;
};

export type SubmissionChange =
  | { readonly kind: "status"; readonly status: SubmissionStatus }
  | { readonly kind: "note"; readonly note: string }
  | { readonly kind: "client"; readonly client: string }
  | { readonly kind: "employer"; readonly employer: string }
  | { readonly kind: "email"; readonly email: string }
  | { readonly kind: "phone"; readonly phone: string }
  | { readonly kind: "rate"; readonly rate: number }
  | { readonly kind: "work_type"; readonly workType: string }
  | { readonly kind: "vendor_contact"; readonly vendorContactId: number | null };

/** Fields accepted by Log1's submission PUT endpoint.
 *
 * They are kept separate from the Slack-facing status/note changes because
 * Log1 does not expose either of those fields on that endpoint.
 */
export type LiveSubmissionFields = {
  readonly client?: string;
  readonly rate?: number;
  readonly employer?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly workType?: string;
  readonly vendorContactId?: number | null;
};

export type NonEmpty<T> = readonly [T, ...T[]];

export type UpdateSubmissionCommand = {
  readonly kind: "update_submission";
  readonly commandId: CommandId;
  readonly actor: ActorContext;
  readonly submissionId: SubmissionId;
  readonly expectedVersion: number;
  readonly changes: NonEmpty<SubmissionChange>;
  readonly liveFields?: LiveSubmissionFields;
};

export type RecordFeedbackCommand = {
  readonly kind: "record_feedback";
  readonly commandId: CommandId;
  readonly actor: ActorContext;
  readonly submissionId: SubmissionId;
  readonly interviewId: InterviewId;
  readonly expectedVersion: number;
  readonly recommendation: FeedbackRecommendation;
  readonly score: Score;
  readonly strengths: string;
  readonly concerns: string;
  readonly notes: string;
  /** Live Log1 questionnaire fields. Legacy callers may omit them. */
  readonly codingInvolved?: boolean;
  readonly finalRound?: boolean;
};

export type FeedbackRecordResult = {
  readonly submission: SubmissionSnapshot;
  readonly interview: InterviewSnapshot;
};

export type Log1ErrorCode =
  | "auth_required"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "temporarily_unavailable";

export type Log1Error =
  | { readonly kind: "auth_required"; readonly message: string }
  | { readonly kind: "not_found"; readonly message: string; readonly resource: "submission" | "interview" }
  | {
      readonly kind: "validation";
      readonly message: string;
      readonly field?: string;
    }
  | {
      readonly kind: "conflict";
      readonly message: string;
      readonly expectedVersion: number;
      readonly currentVersion: number;
    }
  | { readonly kind: "rate_limited"; readonly message: string }
  | { readonly kind: "temporarily_unavailable"; readonly message: string };

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface Log1Port {
  findSubmissions(actor: ActorContext, query: string): Promise<Result<readonly SubmissionSnapshot[], Log1Error>>;
  getSubmission(actor: ActorContext, id: SubmissionId): Promise<Result<SubmissionSnapshot, Log1Error>>;
  updateSubmission(command: UpdateSubmissionCommand): Promise<Result<SubmissionSnapshot, Log1Error>>;
  recordFeedback(command: RecordFeedbackCommand): Promise<Result<FeedbackRecordResult, Log1Error>>;
}

const nonEmpty = (value: string, name: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} must be non-empty`);
  }
  return trimmed;
};

const branded = <Name extends string>(value: string, name: Name): Brand<string, Name> => {
  const trimmed = nonEmpty(value, name);
  return trimmed as Brand<string, Name>;
};

export const submissionId = (value: string): SubmissionId => branded(value, "SubmissionId");
export const interviewId = (value: string): InterviewId => branded(value, "InterviewId");
export const actorId = (value: string): ActorId => branded(value, "ActorId");
export const workspaceId = (value: string): WorkspaceId => branded(value, "WorkspaceId");
export const commandId = (value: string): CommandId => branded(value, "CommandId");

export const authenticatedActor = (input: {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly accessToken: string;
}): ActorContext => ({
  kind: "authenticated",
  actorId: actorId(input.actorId),
  workspaceId: workspaceId(input.workspaceId),
  accessToken: nonEmpty(input.accessToken, "accessToken"),
});

export const unauthenticatedActor = (): ActorContext => ({ kind: "unauthenticated" });

export const isSubmissionStatus = (value: string): value is SubmissionStatus =>
  ["new", "screening", "onsite", "offer", "hired", "rejected", "withdrawn"].includes(value);

export const isFeedbackRecommendation = (value: string): value is FeedbackRecommendation =>
  ["strong_yes", "yes", "mixed", "no", "strong_no"].includes(value);

export const isScore = (value: number): value is Score => Number.isInteger(value) && value >= 1 && value <= 5;

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
