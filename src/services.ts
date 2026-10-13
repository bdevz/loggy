import { createHash } from "node:crypto";
import {
  type CommandId,
  type FeedbackRecordResult,
  type Log1Error,
  type Log1Port,
  type RecordFeedbackCommand,
  type Result,
  type SubmissionSnapshot,
  type UpdateSubmissionCommand,
} from "./domain";

type StoredResult<T> = Result<T, Log1Error>;
export type IdempotencyOperation = "update_submission" | "record_feedback";
export type IdempotencyScope = {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly operation: IdempotencyOperation;
  readonly commandId: CommandId;
};

type Pending<T> = {
  readonly fingerprint: string;
  readonly promise: Promise<StoredResult<T>>;
  readonly resolve: (result: StoredResult<T>) => void;
};
type Entry<T> = Pending<T> & { result?: StoredResult<T> };

const idempotencyKey = (scope: IdempotencyScope): string =>
  `${scope.workspaceId}\u0000${scope.actorId}\u0000${scope.operation}\u0000${scope.commandId}`;

const replayConflict = <T>(): StoredResult<T> => ({
  ok: false,
  error: { kind: "validation", field: "commandId", message: "This command ID was already used with a different payload." },
});

/** A process-local, atomic reservation store. The reservation is inserted before the first await. */
export class InMemoryIdempotencyStore<T> {
  private readonly entries = new Map<string, Entry<T>>();

  async execute(scope: IdempotencyScope, fingerprint: string, operation: () => Promise<StoredResult<T>>): Promise<StoredResult<T>> {
    const key = idempotencyKey(scope);
    const prior = this.entries.get(key);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) return replayConflict<T>();
      if (prior.result !== undefined) return prior.result;
      return prior.promise;
    }

    let resolvePromise: (result: StoredResult<T>) => void = () => undefined;
    const promise = new Promise<StoredResult<T>>((resolve) => {
      resolvePromise = resolve;
    });
    const entry: Entry<T> = { fingerprint, promise, resolve: resolvePromise };
    this.entries.set(key, entry);
    try {
      const result = await operation();
      entry.result = result;
      entry.resolve(result);
      return result;
    } catch (error) {
      const result: StoredResult<T> = {
        ok: false,
        error: { kind: "temporarily_unavailable", message: error instanceof Error ? error.message : "Operation failed." },
      };
      entry.result = result;
      entry.resolve(result);
      return result;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

const commandFingerprint = (command: UpdateSubmissionCommand | RecordFeedbackCommand): string => {
  const payload = command.kind === "update_submission"
    ? {
        kind: command.kind,
        submissionId: command.submissionId,
        expectedVersion: command.expectedVersion,
        changes: command.changes,
        liveFields: command.liveFields ?? null,
      }
    : {
        kind: command.kind,
        submissionId: command.submissionId,
        interviewId: command.interviewId,
        expectedVersion: command.expectedVersion,
        recommendation: command.recommendation,
        score: command.score,
        strengths: command.strengths,
        concerns: command.concerns,
        notes: command.notes,
        codingInvolved: command.codingInvolved ?? null,
        finalRound: command.finalRound ?? null,
      };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
};

const scopeFor = (command: UpdateSubmissionCommand | RecordFeedbackCommand): IdempotencyScope => {
  if (command.actor.kind !== "authenticated") {
    return { workspaceId: "unauthenticated", actorId: "unauthenticated", operation: command.kind, commandId: command.commandId };
  }
  return { workspaceId: command.actor.workspaceId, actorId: command.actor.actorId, operation: command.kind, commandId: command.commandId };
};

export class UpdateSubmissionService {
  constructor(
    private readonly port: Log1Port,
    private readonly idempotency = new InMemoryIdempotencyStore<SubmissionSnapshot>(),
  ) {}

  execute(command: UpdateSubmissionCommand): Promise<StoredResult<SubmissionSnapshot>> {
    return this.idempotency.execute(scopeFor(command), commandFingerprint(command), () => this.port.updateSubmission(command));
  }
}

export class FeedbackService {
  constructor(
    private readonly port: Log1Port,
    private readonly idempotency = new InMemoryIdempotencyStore<FeedbackRecordResult>(),
  ) {}

  execute(command: RecordFeedbackCommand): Promise<StoredResult<FeedbackRecordResult>> {
    return this.idempotency.execute(scopeFor(command), commandFingerprint(command), () => this.port.recordFeedback(command));
  }
}

export const describeLog1Error = (error: Log1Error): string => {
  switch (error.kind) {
    case "auth_required":
      return "Log1 authentication is required. Connect an authorized Log1 account before trying again.";
    case "not_found":
      return error.resource === "submission" ? "No matching submission was found. Check the candidate name or email." : "That interview could not be found for this submission.";
    case "validation":
      return error.message;
    case "conflict":
      return "This submission changed in Log1. Re-open the modal and submit the current version.";
    case "rate_limited":
      return "Log1 is rate limiting requests. Wait a moment and try again.";
    case "temporarily_unavailable":
      return "Log1 is temporarily unavailable. Try again later.";
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};
