import { createHmac } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticatedActor,
  actorId,
  commandId,
  err,
  submissionId,
  unauthenticatedActor,
  type Result,
  type Log1Error,
  type Log1Port,
  type SubmissionSnapshot,
} from "./domain";
import { InMemoryLog1Port, seededInterviewIds, seededSubmissionIds } from "./log1-port";
import { FeedbackService, UpdateSubmissionService } from "./services";
import {
  buildFeedbackModal,
  buildUpdateSubmissionModal,
  parseModalSubmission,
  routeSlashCommand,
  runSlashCommand,
  type SlackApi,
  type SlackModal,
  verifySlackSignature,
} from "./slack";

const actor = authenticatedActor({ actorId: "U-TEST", workspaceId: "T-TEST", accessToken: "token" });

const valueOf = <T>(result: Result<T, Log1Error>): T => {
  if (result.ok === false) {
    throw new Error(result.error.message);
  }
  return result.value;
};

const getAlex = async (port: InMemoryLog1Port): Promise<SubmissionSnapshot> =>
  valueOf(await port.getSubmission(actor, seededSubmissionIds.alex));

const slashPayload = {
  type: "slash_command",
  command: "/log1",
  text: "update Alex Rivera",
  user_id: "U-TEST",
  team_id: "T-TEST",
  trigger_id: "trigger-1",
  channel_id: "C-TEST",
} as const;

const delegatedPort = (findSubmissions: Log1Port["findSubmissions"]): Log1Port => {
  const fixture = new InMemoryLog1Port();
  return {
    findSubmissions,
    getSubmission: (requestActor, id) => fixture.getSubmission(requestActor, id),
    updateSubmission: (command) => fixture.updateSubmission(command),
    recordFeedback: (command) => fixture.recordFeedback(command),
  };
};

const recordingSlackApi = (events: string[], updatedViews: SlackModal[]): SlackApi => ({
  async viewsOpen({ view }) {
    events.push(`open:${view.callback_id}`);
    return { viewId: "V-TEST", hash: "H-TEST" };
  },
  async viewsUpdate({ view }) {
    events.push(`update:${view.callback_id}`);
    updatedViews.push(view);
  },
  async postEphemeral({ text }) {
    events.push(`ephemeral:${text}`);
  },
});

test("verifies Slack signatures and rejects stale or tampered requests", () => {
  const body = "command=%2Flog1&text=help";
  const secret = "signing-secret";
  const timestamp = 1_700_000_000;
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  assert.equal(verifySlackSignature(body, String(timestamp), signature, secret, timestamp * 1000), true);
  assert.equal(verifySlackSignature(body, String(timestamp - 301), signature, secret, timestamp * 1000), false);
  assert.equal(verifySlackSignature(body, String(timestamp), `${signature}x`, secret, timestamp * 1000), false);
});

test("routes help, update, and feedback slash commands", async () => {
  const port = new InMemoryLog1Port();
  const help = await routeSlashCommand({
    payload: { command: "/log1", text: "help", user_id: "U-TEST", team_id: "T-TEST" },
    actor,
    port,
    commandId: commandId("cmd-help"),
  });
  assert.match(help.text, /\/log1 update/);

  const update = await routeSlashCommand({
    payload: { command: "/log1", text: "update Alex Rivera", user_id: "U-TEST", team_id: "T-TEST" },
    actor,
    port,
    commandId: commandId("cmd-update"),
  });
  assert.equal(update.view?.callback_id, "log1_update_submission");

  const feedback = await routeSlashCommand({
    payload: { command: "/log1", text: "feedback Jordan Lee", user_id: "U-TEST", team_id: "T-TEST" },
    actor,
    port,
    commandId: commandId("cmd-feedback"),
  });
  assert.equal(feedback.view?.callback_id, "log1_feedback");
});

test("opens the loading view before a slow lookup and updates that same view to the form", async () => {
  const events: string[] = [];
  const updatedViews: SlackModal[] = [];
  const fixture = new InMemoryLog1Port();
  const port = delegatedPort(async (requestActor, query, options) => {
    events.push("lookup");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return fixture.findSubmissions(requestActor, query);
  });
  const running = runSlashCommand({ payload: slashPayload, actor, port, commandId: commandId("slow-update"), slackApi: recordingSlackApi(events, updatedViews), lookupTimeoutMs: 100 });
  assert.deepEqual(events, ["open:log1_loading"]);
  await running;
  assert.equal(events[1], "lookup");
  assert.equal(updatedViews[0]?.callback_id, "log1_update_submission");
  assert.equal(events[2], "update:log1_update_submission");
});

test("updates the existing loading view with a timeout and never installs a late form", async () => {
  const events: string[] = [];
  const updatedViews: SlackModal[] = [];
  const fixture = new InMemoryLog1Port();
  const port = delegatedPort(async (requestActor, query, options) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    return fixture.findSubmissions(requestActor, query);
  });
  await runSlashCommand({ payload: slashPayload, actor, port, commandId: commandId("timeout-update"), slackApi: recordingSlackApi(events, updatedViews), lookupTimeoutMs: 5 });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(updatedViews.length, 1);
  assert.equal(updatedViews[0]?.callback_id, "log1_loading");
  const text = updatedViews[0]?.blocks[0];
  assert.equal(text?.type, "section");
  if (text?.type === "section") assert.match(text.text.text, /too long/);
  assert.equal(events.filter((event) => event.startsWith("update:")).length, 1);
});

test("renders lookup errors inside the already-open loading view", async () => {
  const events: string[] = [];
  const updatedViews: SlackModal[] = [];
  const port = delegatedPort(async () => err({ kind: "temporarily_unavailable", message: "Log1 is unavailable." }));
  await runSlashCommand({ payload: slashPayload, actor, port, commandId: commandId("error-update"), slackApi: recordingSlackApi(events, updatedViews) });
  assert.equal(updatedViews.length, 1);
  assert.equal(updatedViews[0]?.callback_id, "log1_loading");
  const text = updatedViews[0]?.blocks[0];
  assert.equal(text?.type, "section");
  if (text?.type === "section") assert.match(text.text.text, /temporarily unavailable/);
});

test("parses update and feedback modal submissions with hidden identifiers", async () => {
  const port = new InMemoryLog1Port();
  const candidate = await getAlex(port);
  const updateView = buildUpdateSubmissionModal(candidate, commandId("cmd-modal-update"));
  const updatePayload = {
    type: "view_submission",
    user: { id: "U-TEST" },
    team: { id: "T-TEST" },
    view: {
      ...updateView,
      state: {
        values: {
          status_input: { status: { type: "static_select", action_id: "status", selected_option: { value: "onsite" } } },
          note_input: { note: { type: "plain_text_input", action_id: "note", value: "Ready for panel." } },
        },
      },
    },
  };
  const update = valueOf(parseModalSubmission(updatePayload, actor));
  assert.equal(update.kind, "update_submission");
  assert.equal(update.submissionId, seededSubmissionIds.alex);
  assert.equal(update.expectedVersion, candidate.version);

  const interview = candidate.interviews[0];
  assert.ok(interview);
  const feedbackView = buildFeedbackModal(candidate, interview, commandId("cmd-modal-feedback"));
  const feedbackPayload = {
    type: "view_submission",
    user: { id: "U-TEST" },
    team: { id: "T-TEST" },
    view: {
      ...feedbackView,
      state: {
        values: {
          coding_input: { coding: { type: "static_select", action_id: "coding", selected_option: { value: "no" } } },
          final_round_input: { final_round: { type: "static_select", action_id: "final_round", selected_option: { value: "no" } } },
          recommendation_input: { recommendation: { type: "static_select", action_id: "recommendation", selected_option: { value: "strong_yes" } } },
          score_input: { score: { type: "static_select", action_id: "score", selected_option: { value: "5" } } },
          strengths_input: { strengths: { type: "plain_text_input", action_id: "strengths", value: "Excellent communication." } },
          concerns_input: { concerns: { type: "plain_text_input", action_id: "concerns", value: "" } },
          notes_input: { notes: { type: "plain_text_input", action_id: "notes", value: "Hire." } },
        },
      },
    },
  };
  const feedback = valueOf(parseModalSubmission(feedbackPayload, actor));
  assert.equal(feedback.kind, "record_feedback");
  assert.equal(feedback.interviewId, seededInterviewIds.alex);
  assert.equal(feedback.score, 5);
  assert.equal(feedback.codingInvolved, false);
  assert.equal(feedback.finalRound, false);
});

test("parses the live Log1 update form into the API field set", () => {
  const liveCandidate: SubmissionSnapshot = {
    id: submissionId("125002"),
    candidateName: "Nisha Karki",
    candidateEmail: "nisha@example.test",
    role: "Principal Engineer",
    status: "new",
    note: "",
    version: 1_760_000_000,
    updatedAt: "2026-10-12T20:50:41.000Z",
    interviews: [],
    client: "Turing",
    employer: "marketing-new",
    phone: "123",
    rate: 170000,
    workType: "full_time",
    vendorContactId: null,
    modifiedAt: "2026-10-12T20:50:41.000Z",
  };
  const modal = buildUpdateSubmissionModal(liveCandidate, commandId("live-update"));
  const parsed = valueOf(parseModalSubmission({
    type: "view_submission",
    user: { id: "U-TEST" },
    team: { id: "T-TEST" },
    view: {
      ...modal,
      state: {
        values: {
          client_input: { client: { type: "plain_text_input", action_id: "client", value: "New client" } },
          rate_input: { rate: { type: "plain_text_input", action_id: "rate", value: "185000" } },
          employer_input: { employer: { type: "plain_text_input", action_id: "employer", value: "New employer" } },
          email_input: { email: { type: "plain_text_input", action_id: "email", value: "new@example.test" } },
          phone_input: { phone: { type: "plain_text_input", action_id: "phone", value: "+1 555 0199" } },
          work_type_input: { work_type: { type: "plain_text_input", action_id: "work_type", value: "full_time" } },
        },
      },
    },
  }, actor));
  assert.equal(parsed.kind, "update_submission");
  assert.deepEqual(parsed.liveFields, {
    client: "New client",
    rate: 185000,
    employer: "New employer",
    email: "new@example.test",
    phone: "+1 555 0199",
    workType: "full_time",
  });
});

test("builds and parses the live Log1 multi-select feedback questionnaire", async () => {
  const port = new InMemoryLog1Port();
  const candidate = await getAlex(port);
  const interview = candidate.interviews[0];
  assert.ok(interview);
  const liveCandidate: SubmissionSnapshot = {
    ...candidate,
    client: "Turing",
    interviews: [{
      ...interview,
      feedback: {
        recommendation: "yes",
        score: 4,
        strengths: "Proper resume, Coding on time",
        concerns: "Technical Difficulties, None",
        notes: "Existing remark",
        submittedBy: actorId("U-TEST"),
        submittedAt: "2026-10-12T20:50:41.000Z",
      },
    }],
  };
  const modal = buildFeedbackModal(liveCandidate, liveCandidate.interviews[0]!, commandId("live-feedback-modal"));
  const inputBlock = (blockId: string): Extract<(typeof modal.blocks)[number], { readonly type: "input" }> => {
    const block = modal.blocks.find((item) => item.type === "input" && item.block_id === blockId);
    if (block === undefined || block.type !== "input") throw new Error(`Missing input block ${blockId}`);
    return block;
  };
  const strengthsBlock = inputBlock("strengths_input");
  const concernsBlock = inputBlock("concerns_input");
  const notesBlock = inputBlock("notes_input");
  if (strengthsBlock.element.type !== "multi_static_select") throw new Error("Strengths should use a multi-select.");
  assert.deepEqual(strengthsBlock.element.options.map((item) => item.text.text), [
    "Coding on time",
    "Proper resume",
    "Good Mimicking",
    "Complete details from Marketer",
    "None",
  ]);
  assert.deepEqual(strengthsBlock.element.initial_options?.map((item) => item.text.text), ["Proper resume", "Coding on time"]);
  if (concernsBlock.element.type !== "multi_static_select") throw new Error("Concerns should use a multi-select.");
  assert.deepEqual(concernsBlock.element.options.map((item) => item.text.text), [
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
  ]);
  assert.deepEqual(concernsBlock.element.initial_options?.map((item) => item.text.text), ["Technical Difficulties", "None"]);
  if (notesBlock.element.type !== "plain_text_input") throw new Error("Notes should use a text input.");

  const parsed = valueOf(parseModalSubmission({
    type: "view_submission",
    user: { id: "U-TEST" },
    team: { id: "T-TEST" },
    view: {
      ...modal,
      state: {
        values: {
          coding_input: { coding: { type: "static_select", action_id: "coding", selected_option: { value: "yes" } } },
          final_round_input: { final_round: { type: "static_select", action_id: "final_round", selected_option: { value: "no" } } },
          recommendation_input: { recommendation: { type: "static_select", action_id: "recommendation", selected_option: { value: "yes" } } },
          score_input: { score: { type: "static_select", action_id: "score", selected_option: { value: "4" } } },
          strengths_input: { strengths: { type: "multi_static_select", action_id: "strengths", selected_options: [
            { text: { type: "plain_text", text: "Good Mimicking" }, value: "Good Mimicking" },
            { text: { type: "plain_text", text: "Coding on time" }, value: "Coding on time" },
          ] } },
          concerns_input: { concerns: { type: "multi_static_select", action_id: "concerns", selected_options: [
            { text: { type: "plain_text", text: "Coding Error" }, value: "Coding Error" },
            { text: { type: "plain_text", text: "None" }, value: "None" },
          ] } },
          notes_input: { notes: { type: "plain_text_input", action_id: "notes", value: "Updated remark" } },
        },
      },
    },
  }, actor));
  assert.equal(parsed.kind, "record_feedback");
  assert.equal(parsed.strengths, "Good Mimicking, Coding on time");
  assert.equal(parsed.concerns, "Coding Error, None");
  assert.equal(parsed.notes, "Updated remark");
});

test("keeps an API submission in the live form when optional client data is absent", async () => {
  const port = new InMemoryLog1Port();
  const candidate = await getAlex(port);
  const liveCandidate: SubmissionSnapshot = { ...candidate, modifiedAt: candidate.updatedAt };
  const modal = buildUpdateSubmissionModal(liveCandidate, commandId("live-update-without-client"));
  assert.match(modal.private_metadata, /\"form\":\"live\"/);
  assert.equal(modal.blocks.some((block) => block.type === "input" && block.block_id === "client_input"), true);
  assert.equal(modal.blocks.some((block) => block.type === "input" && block.block_id === "status_input"), false);
});

test("rejects non-view submissions and action shapes that do not match the modal registry", async () => {
  const port = new InMemoryLog1Port();
  const candidate = await getAlex(port);
  const modal = buildUpdateSubmissionModal(candidate, commandId("cmd-strict-boundary"));
  const base = {
    type: "view_submission",
    user: { id: "U-TEST" },
    team: { id: "T-TEST" },
    view: {
      ...modal,
      state: {
        values: {
          status_input: { status: { type: "static_select", action_id: "status", selected_option: { value: "onsite" } } },
          note_input: { note: { type: "plain_text_input", action_id: "note", value: "Ready." } },
        },
      },
    },
  };
  assert.equal(parseModalSubmission({ ...base, type: "block_actions" }, actor).ok, false);
  const malformed = structuredClone(base);
  malformed.view.state.values.status_input.status.type = "plain_text_input";
  assert.equal(parseModalSubmission(malformed, actor).ok, false);
});

test("updates successfully and replays a duplicate command without a second port call", async () => {
  const port = new InMemoryLog1Port();
  const service = new UpdateSubmissionService(port);
  const candidate = await getAlex(port);
  const command = {
    kind: "update_submission" as const,
    commandId: commandId("cmd-idempotent-update"),
    actor,
    submissionId: candidate.id,
    expectedVersion: candidate.version,
    changes: [{ kind: "status" as const, status: "onsite" as const }, { kind: "note" as const, note: "Panel loop." }] as const,
  };
  const first = valueOf(await service.execute(command));
  const callsAfterFirst = port.calls.updateSubmission;
  const second = valueOf(await service.execute(command));
  assert.equal(first.version, candidate.version + 1);
  assert.deepEqual(second, first);
  assert.equal(port.calls.updateSubmission, callsAfterFirst);
});

test("records feedback successfully and replays a duplicate command without a second port call", async () => {
  const port = new InMemoryLog1Port();
  const service = new FeedbackService(port);
  const candidate = await getAlex(port);
  const command = {
    kind: "record_feedback" as const,
    commandId: commandId("cmd-idempotent-feedback"),
    actor,
    submissionId: candidate.id,
    interviewId: seededInterviewIds.alex,
    expectedVersion: candidate.version,
    recommendation: "yes" as const,
    score: 4 as const,
    strengths: "Clear thinking.",
    concerns: "None recorded.",
    notes: "Advance.",
  };
  const first = valueOf(await service.execute(command));
  const callsAfterFirst = port.calls.recordFeedback;
  const second = valueOf(await service.execute(command));
  assert.equal(first.submission.version, candidate.version + 1);
  assert.deepEqual(second, first);
  assert.equal(port.calls.recordFeedback, callsAfterFirst);
});

test("returns a stale-version conflict and handles unauthenticated or unknown targets", async () => {
  const port = new InMemoryLog1Port();
  const candidate = await getAlex(port);
  const updateService = new UpdateSubmissionService(port);
  const first = valueOf(
    await updateService.execute({
      kind: "update_submission",
      commandId: commandId("cmd-first-update"),
      actor,
      submissionId: candidate.id,
      expectedVersion: candidate.version,
      changes: [{ kind: "note", note: "First writer." }],
    }),
  );
  assert.equal(first.version, candidate.version + 1);
  const stale = await port.updateSubmission({
    kind: "update_submission",
    commandId: commandId("cmd-stale-update"),
    actor,
    submissionId: candidate.id,
    expectedVersion: candidate.version,
    changes: [{ kind: "status", status: "offer" }],
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.kind, "conflict");
  }

  const unauthenticated = await port.findSubmissions(unauthenticatedActor(), "Alex");
  assert.equal(unauthenticated.ok, false);
  if (!unauthenticated.ok) {
    assert.equal(unauthenticated.error.kind, "auth_required");
  }
  const unknown = await port.getSubmission(actor, submissionId("missing-submission"));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.kind, "not_found");
  }
});

test("reserves concurrent work and rejects a reused command ID with a different payload", async () => {
  const port = new InMemoryLog1Port();
  const service = new UpdateSubmissionService(port);
  const candidate = await getAlex(port);
  const command = {
    kind: "update_submission" as const,
    commandId: commandId("cmd-concurrent"),
    actor,
    submissionId: candidate.id,
    expectedVersion: candidate.version,
    changes: [{ kind: "note" as const, note: "Concurrent writer." }] as const,
  };
  const [first, second] = await Promise.all([service.execute(command), service.execute(command)]);
  assert.deepEqual(first, second);
  assert.equal(port.calls.updateSubmission, 1);
  const mismatch = await service.execute({ ...command, changes: [{ kind: "note" as const, note: "Different payload." }] as const });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.error.kind, "validation");
    if (mismatch.error.kind === "validation") assert.equal(mismatch.error.field, "commandId");
  }
  assert.equal(port.calls.updateSubmission, 1);
});
