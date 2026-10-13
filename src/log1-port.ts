import {
  type ActorContext,
  type FeedbackRecordResult,
  type FeedbackRecommendation,
  type InterviewSnapshot,
  type Log1Error,
  type Log1Port,
  type RecordFeedbackCommand,
  type Result,
  type Score,
  type SubmissionSnapshot,
  type SubmissionStatus,
  type SubmissionId,
  type UpdateSubmissionCommand,
  err,
  interviewId,
  isFeedbackRecommendation,
  isScore,
  isSubmissionStatus,
  ok,
  submissionId,
} from "./domain";

type SeedSubmission = Omit<SubmissionSnapshot, "id" | "interviews"> & {
  readonly id: string;
  readonly interviews: readonly (Omit<InterviewSnapshot, "id" | "submissionId"> & { readonly id: string })[];
};

const authError = (): Log1Error => ({
  kind: "auth_required",
  message: "A Log1 actor token is required for this operation.",
});

const notFound = (resource: "submission" | "interview", identifier: string): Log1Error => ({
  kind: "not_found",
  resource,
  message: `${resource} ${identifier} was not found.`,
});

const validation = (message: string, field?: string): Log1Error =>
  field === undefined ? { kind: "validation", message } : { kind: "validation", message, field };

const conflict = (expectedVersion: number, currentVersion: number): Log1Error => ({
  kind: "conflict",
  expectedVersion,
  currentVersion,
  message: `The submission changed from version ${expectedVersion}; current version is ${currentVersion}.`,
});

const cloneInterview = (interview: InterviewSnapshot): InterviewSnapshot => ({
  ...interview,
  feedback: interview.feedback === null ? null : { ...interview.feedback },
});

const cloneSubmission = (submission: SubmissionSnapshot): SubmissionSnapshot => ({
  ...submission,
  interviews: submission.interviews.map(cloneInterview),
});

const seeds: readonly SeedSubmission[] = [
  {
    id: "sub-alex-rivera",
    candidateName: "Alex Rivera",
    candidateEmail: "alex.rivera@example.test",
    role: "Senior Product Designer",
    status: "screening",
    note: "Strong portfolio in workflow tooling; recruiter screen is next.",
    version: 3,
    updatedAt: "2026-01-15T10:00:00.000Z",
    interviews: [
      {
        id: "int-alex-panel",
        title: "Portfolio panel",
        interviewer: "Maya Chen",
        scheduledAt: "2026-01-20T15:00:00.000Z",
        status: "completed",
        feedback: null,
      },
    ],
  },
  {
    id: "sub-jordan-lee",
    candidateName: "Jordan Lee",
    candidateEmail: "jordan.lee@example.test",
    role: "Backend Engineer",
    status: "onsite",
    note: "Excellent distributed systems experience; finish onsite loop.",
    version: 5,
    updatedAt: "2026-01-16T09:30:00.000Z",
    interviews: [
      {
        id: "int-jordan-systems",
        title: "Systems design",
        interviewer: "Sam Okafor",
        scheduledAt: "2026-01-22T17:30:00.000Z",
        status: "completed",
        feedback: null,
      },
    ],
  },
  {
    id: "sub-priya-nair",
    candidateName: "Priya Nair",
    candidateEmail: "priya.nair@example.test",
    role: "Customer Success Lead",
    status: "offer",
    note: "Offer approved; awaiting candidate response.",
    version: 2,
    updatedAt: "2026-01-14T13:15:00.000Z",
    interviews: [
      {
        id: "int-priya-final",
        title: "Final leadership interview",
        interviewer: "Taylor Brooks",
        scheduledAt: "2026-01-10T14:00:00.000Z",
        status: "completed",
        feedback: null,
      },
    ],
  },
];

export type InMemoryCallCounts = {
  findSubmissions: number;
  getSubmission: number;
  updateSubmission: number;
  recordFeedback: number;
};

export class InMemoryLog1Port implements Log1Port {
  private readonly submissions = new Map<SubmissionId, SubmissionSnapshot>();
  readonly calls: InMemoryCallCounts = {
    findSubmissions: 0,
    getSubmission: 0,
    updateSubmission: 0,
    recordFeedback: 0,
  };

  constructor(initial: readonly SeedSubmission[] = seeds) {
    for (const seed of initial) {
      const id = submissionId(seed.id);
      this.submissions.set(id, {
        id,
        candidateName: seed.candidateName,
        candidateEmail: seed.candidateEmail,
        role: seed.role,
        status: seed.status,
        note: seed.note,
        version: seed.version,
        updatedAt: seed.updatedAt,
        interviews: seed.interviews.map((interview) => ({
          ...interview,
          id: interviewId(interview.id),
          submissionId: id,
          feedback: interview.feedback === null ? null : { ...interview.feedback },
        })),
      });
    }
  }

  async findSubmissions(actor: ActorContext, query: string): Promise<Result<readonly SubmissionSnapshot[], Log1Error>> {
    this.calls.findSubmissions += 1;
    if (actor.kind !== "authenticated") {
      return err(authError());
    }

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = [...this.submissions.values()]
      .filter((submission) => {
        if (normalizedQuery.length === 0) {
          return true;
        }
        return [submission.candidateName, submission.candidateEmail, submission.role, submission.id]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      })
      .map(cloneSubmission);
    return ok(matches);
  }

  async getSubmission(actor: ActorContext, id: SubmissionId): Promise<Result<SubmissionSnapshot, Log1Error>> {
    this.calls.getSubmission += 1;
    if (actor.kind !== "authenticated") {
      return err(authError());
    }
    const submission = this.submissions.get(id);
    return submission === undefined ? err(notFound("submission", id)) : ok(cloneSubmission(submission));
  }

  async updateSubmission(command: UpdateSubmissionCommand): Promise<Result<SubmissionSnapshot, Log1Error>> {
    this.calls.updateSubmission += 1;
    if (command.actor.kind !== "authenticated") {
      return err(authError());
    }
    if (command.changes.length === 0) {
      return err(validation("At least one submission change is required.", "changes"));
    }
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) {
      return err(validation("Expected version must be a non-negative integer.", "expectedVersion"));
    }
    const submission = this.submissions.get(command.submissionId);
    if (submission === undefined) {
      return err(notFound("submission", command.submissionId));
    }
    if (submission.version !== command.expectedVersion) {
      return err(conflict(command.expectedVersion, submission.version));
    }

    let nextStatus: SubmissionStatus = submission.status;
    let nextNote = submission.note;
    let nextClient = submission.client;
    let nextEmployer = submission.employer;
    let nextEmail = submission.candidateEmail;
    let nextPhone = submission.phone;
    let nextRate = submission.rate;
    let nextWorkType = submission.workType;
    let nextVendorContactId = submission.vendorContactId;
    for (const change of command.changes) {
      switch (change.kind) {
        case "status":
          if (!isSubmissionStatus(change.status)) return err(validation("Status is invalid.", "status"));
          nextStatus = change.status;
          break;
        case "note": {
          const trimmedNote = change.note.trim();
          if (trimmedNote.length > 2000) return err(validation("Notes must be 2,000 characters or fewer.", "note"));
          nextNote = trimmedNote;
          break;
        }
        case "client":
          nextClient = change.client.trim();
          break;
        case "employer":
          nextEmployer = change.employer.trim();
          break;
        case "email":
          nextEmail = change.email.trim();
          break;
        case "phone":
          nextPhone = change.phone.trim();
          break;
        case "rate":
          if (!Number.isFinite(change.rate) || change.rate < 0) return err(validation("Rate must be a non-negative number.", "rate"));
          nextRate = change.rate;
          break;
        case "work_type":
          nextWorkType = change.workType.trim();
          break;
        case "vendor_contact":
          nextVendorContactId = change.vendorContactId;
          break;
      }
    }

    const next: SubmissionSnapshot = {
      ...submission,
      ...(nextClient === undefined ? {} : { client: nextClient }),
      ...(nextEmployer === undefined ? {} : { employer: nextEmployer }),
      candidateEmail: nextEmail,
      ...(nextPhone === undefined ? {} : { phone: nextPhone }),
      ...(nextRate === undefined ? {} : { rate: nextRate }),
      ...(nextWorkType === undefined ? {} : { workType: nextWorkType }),
      ...(nextVendorContactId === undefined ? {} : { vendorContactId: nextVendorContactId }),
      status: nextStatus,
      note: nextNote,
      version: submission.version + 1,
      updatedAt: deterministicTimestamp(submission.version + 1),
      interviews: submission.interviews.map(cloneInterview),
    };
    this.submissions.set(next.id, next);
    return ok(cloneSubmission(next));
  }

  async recordFeedback(command: RecordFeedbackCommand): Promise<Result<FeedbackRecordResult, Log1Error>> {
    this.calls.recordFeedback += 1;
    if (command.actor.kind !== "authenticated") {
      return err(authError());
    }
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) {
      return err(validation("Expected version must be a non-negative integer.", "expectedVersion"));
    }
    if (!isFeedbackRecommendation(command.recommendation) || !isScore(command.score)) {
      return err(validation("Recommendation and score are invalid."));
    }
    const submission = this.submissions.get(command.submissionId);
    if (submission === undefined) {
      return err(notFound("submission", command.submissionId));
    }
    if (submission.version !== command.expectedVersion) {
      return err(conflict(command.expectedVersion, submission.version));
    }
    const interviewIndex = submission.interviews.findIndex((interview) => interview.id === command.interviewId);
    if (interviewIndex < 0) {
      return err(notFound("interview", command.interviewId));
    }
    const existingInterview = submission.interviews[interviewIndex];
    if (existingInterview === undefined) {
      return err(notFound("interview", command.interviewId));
    }
    if (existingInterview.status !== "completed") {
      return err(validation("Feedback can only be recorded for a completed interview.", "interviewId"));
    }
    if (command.strengths.trim().length > 2000 || command.concerns.trim().length > 2000 || command.notes.trim().length > 2000) {
      return err(validation("Feedback fields must be 2,000 characters or fewer."));
    }

    const feedback = {
      recommendation: command.recommendation,
      score: command.score,
      strengths: command.strengths.trim(),
      concerns: command.concerns.trim(),
      notes: command.notes.trim(),
      submittedBy: command.actor.actorId,
      submittedAt: deterministicTimestamp(submission.version + 1),
    };
    const nextInterview: InterviewSnapshot = {
      ...existingInterview,
      feedback,
    };
    const nextInterviews = submission.interviews.map((interview, index) =>
      index === interviewIndex ? nextInterview : cloneInterview(interview),
    );
    const nextSubmission: SubmissionSnapshot = {
      ...submission,
      version: submission.version + 1,
      updatedAt: deterministicTimestamp(submission.version + 1),
      interviews: nextInterviews,
    };
    this.submissions.set(nextSubmission.id, nextSubmission);
    return ok({ submission: cloneSubmission(nextSubmission), interview: cloneInterview(nextInterview) });
  }
}

const deterministicTimestamp = (version: number): string =>
  `2026-01-31T00:${String(version % 60).padStart(2, "0")}:00.000Z`;

export { RealLog1Port } from "./real-log1-port";

export const seededSubmissionIds = {
  alex: submissionId("sub-alex-rivera"),
  jordan: submissionId("sub-jordan-lee"),
  priya: submissionId("sub-priya-nair"),
} as const;

export const seededInterviewIds = {
  alex: interviewId("int-alex-panel"),
  jordan: interviewId("int-jordan-systems"),
  priya: interviewId("int-priya-final"),
} as const;

export type { FeedbackRecommendation, Score };
