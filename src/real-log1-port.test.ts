import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedActor, commandId, interviewId, submissionId, unauthenticatedActor, type ActorContext } from "./domain";
import { RealLog1Port } from "./real-log1-port";

const actor: ActorContext = authenticatedActor({ actorId: "U-1", workspaceId: "T-1", accessToken: "secret" });
const submission = {
  id: 7,
  consultant_name: "Nisha Karki",
  email: "nisha@example.test",
  status: "sub",
  modified: "2026-10-12T20:50:41.247290Z",
  client: "Turing",
  employer: "marketing-new",
  rate: 170000,
  work_type: "full_time",
  lead: { job_title: "Principal Engineer" },
};
const interview = {
  id: 12,
  submission: { id: 7 },
  status: "completed",
  start_time: "2026-10-13T12:00:00Z",
  screening_type: "Technical",
  supervisor: { name: "Maya Chen" },
};

const response = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("maps live submission and interview list responses and scopes the token", async () => {
  const requests: Array<{ url: URL; authorization: string | null; accept: string | null }> = [];
  const port = new RealLog1Port({
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization"), accept: new Headers(init?.headers).get("accept") });
      if (url.pathname === "/api/submission/") return response({ counts: { total: 1 }, data: [submission] });
      if (url.pathname === "/api/v2/submission/7/interviews/") return response({ data: [interview] });
      return response({ detail: "unexpected" }, 404);
    },
  });
  const result = await port.findSubmissions(actor, "Nisha Karki");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0]?.candidateName, "Nisha Karki");
  assert.equal(result.value[0]?.status, "new");
  assert.equal(result.value[0]?.interviews[0]?.id, "12");
  assert.equal(requests.every((request) => request.authorization === "Token secret"), true);
  assert.equal(requests.every((request) => request.url.origin === "https://api.log1.com"), true);
  assert.equal(requests.every((request) => request.accept === "application/json"), true);
  assert.match(requests[0]?.url.pathname ?? "", /^\/api\/submission\/$/);
  assert.match(requests[0]?.url.search ?? "", /query=Nisha%20Karki/);
});

test("maps next-round interviews, supervisor answers, supervisor name, and lead modified timestamp", async () => {
  const liveSubmission = {
    id: 124907,
    consultant_name: "Nisha Karki",
    email: "nisha@example.test",
    status: "interview",
    work_type: "Full Time",
    lead: { job_title: "Principal Engineer", modified: "2026-10-12T20:50:41.247290Z" },
  };
  const liveInterview = {
    id: 912,
    submission: 124907,
    status: "next_round",
    created: "2026-10-13T12:00:00Z",
    modified: "2026-10-13T12:30:00Z",
    screening_type: "Technical",
    supervisor: { supervisor_name: "ALOK KUMAR SINGH" },
    feedback: "legacy text should not win",
    supervisor_feedback: [
      { question_answer: { answer: "Yes", ques_id: 44, ques_title: "Was coding involved in call", answer_type: "Single Select" } },
      { question_answer: { answer: "No", ques_id: 55, ques_title: "Is it a final round", answer_type: "Single Select" } },
      { question_answer: { answer: "Satisfied", ques_id: 49, ques_title: "Overall Call Rating", answer_type: "Rate" } },
      { question_answer: { answer: "Clear communication, Strong debugging", ques_id: 47, ques_title: "What went well in call", answer_type: "Multi Select" } },
      { question_answer: { answer: "None", ques_id: 48, ques_title: "Issues faced during call", answer_type: "Multi Select" } },
      { question_answer: { answer: "Advance", ques_id: 50, ques_title: "Remark", answer_type: "Text" } },
    ],
  };
  const port = new RealLog1Port({
    fetch: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/submission/") return response({ data: [liveSubmission] });
      if (url.pathname === "/api/v2/submission/124907/interviews/") return response({ data: [liveInterview] });
      return response({ detail: "unexpected" }, 404);
    },
  });
  const result = await port.findSubmissions(actor, "Nisha Karki");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value[0], {
    id: "124907",
    candidateName: "Nisha Karki",
    candidateEmail: "nisha@example.test",
    role: "Principal Engineer",
    status: "onsite",
    note: "",
    version: Math.floor(Date.parse("2026-10-12T20:50:41.247290Z") / 1000),
    updatedAt: "2026-10-12T20:50:41.247290Z",
    interviews: [{
      id: "912",
      submissionId: "124907",
      title: "Technical",
      interviewer: "ALOK KUMAR SINGH",
      scheduledAt: "2026-10-13T12:00:00Z",
      status: "completed",
      feedback: {
        recommendation: "mixed",
        score: 4,
        strengths: "Clear communication, Strong debugging",
        concerns: "None",
        notes: "Advance",
        submittedBy: "U-1",
        submittedAt: "2026-10-13T12:30:00Z",
      },
    }],
    workType: "Full Time",
    modifiedAt: "2026-10-12T20:50:41.247290Z",
  });
  const feedbackDuePort = new RealLog1Port({
    fetch: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/submission/") return response({ data: [liveSubmission] });
      if (url.pathname === "/api/v2/submission/124907/interviews/") return response({ data: [{ ...liveInterview, status: "feedback_due" }] });
      return response({ detail: "unexpected" }, 404);
    },
  });
  const feedbackDue = await feedbackDuePort.findSubmissions(actor, "Nisha Karki");
  assert.equal(feedbackDue.ok, true);
  if (feedbackDue.ok) assert.equal(feedbackDue.value[0]?.interviews[0]?.status, "completed");
});

test("records feedback through Log1's multipart supervisor endpoint", async () => {
  const calls: Array<{ path: string; method: string; body: BodyInit | null | undefined }> = [];
  const port = new RealLog1Port({
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      calls.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body });
      if (url.pathname === "/api/v2/submission/7") return response({ data: submission, permission: { update: true } });
      if (url.pathname === "/api/v2/submission/7/interviews/") return response({ data: [interview] });
      if (url.pathname === "/api/interview/12/") return response({ data: interview, permission: { update: true } });
      if (url.pathname === "/api/interview/12/supervisor_feedback/") return response({ message: "saved" });
      return response({ detail: "unexpected" }, 404);
    },
  });
  const currentVersion = Math.floor(Date.parse(submission.modified) / 1000);
  const result = await port.recordFeedback({
    kind: "record_feedback",
    commandId: "feedback-1" as never,
    actor,
    submissionId: "7" as never,
    interviewId: "12" as never,
    expectedVersion: currentVersion,
    recommendation: "yes",
    score: 4,
    strengths: "Clear thinking, Technical depth",
    concerns: "None",
    notes: "Advance.",
  });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.path.endsWith("supervisor_feedback/")).length, 1);
  const feedbackCall = calls.find((call) => call.path.endsWith("supervisor_feedback/"));
  assert.ok(feedbackCall?.body instanceof FormData);
  const payload = feedbackCall?.body instanceof FormData ? feedbackCall.body.get("feedback_form") : null;
  assert.deepEqual(JSON.parse(String(payload)), [
    { question_id: 44, que_value: "Was coding involved in call", answer: "No" },
    { question_id: 55, que_value: "Is it a final round", answer: "No" },
    { question_id: 49, que_value: "Overall Call Rating", answer: "Satisfied" },
    { question_id: 47, que_value: "What went well in call", answer: "Clear thinking, Technical depth" },
    { question_id: 48, que_value: "Issues faced during call", answer: "None" },
    { question_id: 50, que_value: "Remark", answer: "Advance." },
  ]);
});

test("updates Log1 live fields with the documented PUT payload", async () => {
  const liveSubmission = {
    ...submission,
    client: "Old client",
    employer: "Old employer",
    phone: "+1 555 0100",
    rate: 120,
    work_type: "contract",
    vendor_contact: { id: 21 },
  };
  const puts: Array<{ url: URL; body: string; contentType: string | null }> = [];
  const port = new RealLog1Port({
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/v2/submission/7") return response({ data: liveSubmission, permission: { update: true } });
      if (url.pathname === "/api/v2/submission/7/interviews/") return response({ data: [interview] });
      if (url.pathname === "/api/submission/7/" && init?.method === "PUT") {
        puts.push({ url, body: String(init.body), contentType: new Headers(init.headers).get("content-type") });
        return response({ message: "saved" });
      }
      return response({ detail: "unexpected" }, 404);
    },
  });
  const result = await port.updateSubmission({
    kind: "update_submission",
    commandId: commandId("update-1"),
    actor,
    submissionId: submissionId("7"),
    expectedVersion: Math.floor(Date.parse(submission.modified) / 1000),
    changes: [{ kind: "client", client: "New client" }],
    liveFields: {
      client: "New client",
      rate: 185,
      employer: "New employer",
      email: "new@example.test",
      phone: "+1 555 0199",
      workType: "full_time",
      vendorContactId: 34,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(puts.length, 1);
  assert.deepEqual(JSON.parse(puts[0]?.body ?? "{}"), {
    sub_id: 7,
    client: "New client",
    rate: 185,
    employer: "New employer",
    email: "new@example.test",
    phone: "+1 555 0199",
    work_type: "Full Time",
    vendor_contact_id: 34,
  });
  assert.equal(puts[0]?.url.origin, "https://api.log1.com");
  assert.equal(puts[0]?.contentType, "application/json");
});

test("rejects a submission update when Log1 denies update permission before writing", async () => {
  const paths: string[] = [];
  const port = new RealLog1Port({
    fetch: async (input) => {
      const url = new URL(input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/api/v2/submission/7") return response({ data: submission, permission: { update: false } });
      if (url.pathname === "/api/v2/submission/7/interviews/") return response({ data: [interview] });
      return response({ detail: "write should not happen" }, 500);
    },
  });
  const result = await port.updateSubmission({
    kind: "update_submission",
    commandId: commandId("update-denied"),
    actor,
    submissionId: submissionId("7"),
    expectedVersion: Math.floor(Date.parse(submission.modified) / 1000),
    changes: [{ kind: "client", client: "Denied" }],
    liveFields: { client: "Denied" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "validation");
    if (result.error.kind === "validation") assert.equal(result.error.field, "permission");
  }
  assert.equal(paths.includes("/api/submission/7/"), false);
});

test("rejects feedback when Log1 denies update permission before posting multipart data", async () => {
  const paths: string[] = [];
  const port = new RealLog1Port({
    fetch: async (input) => {
      const url = new URL(input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/api/v2/submission/7") return response({ data: submission, permission: { update: false } });
      if (url.pathname === "/api/v2/submission/7/interviews/") return response({ data: [interview] });
      return response({ detail: "feedback should not happen" }, 500);
    },
  });
  const result = await port.recordFeedback({
    kind: "record_feedback",
    commandId: commandId("feedback-denied"),
    actor,
    submissionId: submissionId("7"),
    interviewId: interviewId("12"),
    expectedVersion: Math.floor(Date.parse(submission.modified) / 1000),
    recommendation: "yes",
    score: 4,
    strengths: "Clear thinking.",
    concerns: "None.",
    notes: "Advance.",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "validation");
    if (result.error.kind === "validation") assert.equal(result.error.field, "permission");
  }
  assert.equal(paths.some((path) => path.endsWith("supervisor_feedback/")), false);
});

test("rejects feedback when the interview permission is denied", async () => {
  const paths: string[] = [];
  const port = new RealLog1Port({
    fetch: async (input) => {
      const url = new URL(input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/api/v2/submission/7") return response({ data: submission, permission: { update: true } });
      if (url.pathname === "/api/v2/submission/7/interviews/") return response({ data: [interview] });
      if (url.pathname === "/api/interview/12/") return response({ data: interview, permission: { update: false } });
      return response({ detail: "feedback should not happen" }, 500);
    },
  });
  const result = await port.recordFeedback({
    kind: "record_feedback",
    commandId: commandId("feedback-interview-denied"),
    actor,
    submissionId: submissionId("7"),
    interviewId: interviewId("12"),
    expectedVersion: Math.floor(Date.parse(submission.modified) / 1000),
    recommendation: "yes",
    score: 4,
    strengths: "Clear thinking.",
    concerns: "None.",
    notes: "Advance.",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "validation");
    if (result.error.kind === "validation") assert.equal(result.error.field, "permission");
  }
  assert.equal(paths.some((path) => path.endsWith("supervisor_feedback/")), false);
});

test("rejects feedback when the interview is not completed", async () => {
  const scheduledInterview = { ...interview, status: "scheduled" };
  const paths: string[] = [];
  const port = new RealLog1Port({
    fetch: async (input) => {
      const url = new URL(input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/api/v2/submission/7") return response({ data: submission, permission: { update: true } });
      if (url.pathname === "/api/v2/submission/7/interviews/") return response({ data: [scheduledInterview] });
      if (url.pathname === "/api/interview/12/") return response({ data: scheduledInterview, permission: { update: true } });
      return response({ detail: "feedback should not happen" }, 500);
    },
  });
  const result = await port.recordFeedback({
    kind: "record_feedback",
    commandId: commandId("feedback-scheduled"),
    actor,
    submissionId: submissionId("7"),
    interviewId: interviewId("12"),
    expectedVersion: Math.floor(Date.parse(submission.modified) / 1000),
    recommendation: "yes",
    score: 4,
    strengths: "Clear thinking.",
    concerns: "None.",
    notes: "Advance.",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "validation");
    if (result.error.kind === "validation") assert.equal(result.error.field, "interviewId");
  }
  assert.equal(paths.some((path) => path.endsWith("supervisor_feedback/")), false);
});

test("maps upstream HTTP failures to stable Log1 errors", async () => {
  const cases: ReadonlyArray<{ status: number; kind: string }> = [
    { status: 401, kind: "auth_required" },
    { status: 403, kind: "auth_required" },
    { status: 404, kind: "not_found" },
    { status: 409, kind: "conflict" },
    { status: 429, kind: "rate_limited" },
    { status: 500, kind: "temporarily_unavailable" },
  ];
  for (const testCase of cases) {
    const port = new RealLog1Port({ fetch: async () => response({ detail: "upstream" }, testCase.status) });
    const result = await port.findSubmissions(actor, "Nisha");
    assert.equal(result.ok, false, `status ${testCase.status} should fail`);
    if (!result.ok) assert.equal(result.error.kind, testCase.kind, `status ${testCase.status}`);
  }
});

test("returns a timeout error when the upstream never responds", async () => {
  const port = new RealLog1Port({ fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), timeoutMs: 5 });
  const result = await port.findSubmissions(actor, "Nisha");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "temporarily_unavailable");
    assert.equal(result.error.message, "Log1 request timed out.");
  }
});

test("rejects unauthenticated calls without invoking fetch", async () => {
  let calls = 0;
  const port = new RealLog1Port({ fetch: async () => {
    calls += 1;
    return response({ data: [] });
  } });
  const result = await port.findSubmissions(unauthenticatedActor(), "Nisha");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "auth_required");
  assert.equal(calls, 0);
});

