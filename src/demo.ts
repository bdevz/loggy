import { authenticatedActor, commandId } from "./domain";
import { InMemoryLog1Port, seededSubmissionIds } from "./log1-port";
import { FeedbackService, UpdateSubmissionService } from "./services";
import {
  buildFeedbackModal,
  buildUpdateSubmissionModal,
  makeStableCommandId,
  parseModalSubmission,
  routeSlashCommand,
} from "./slack";

const actor = authenticatedActor({ actorId: "UDEMO", workspaceId: "TDEMO", accessToken: "local-demo-token" });
const port = new InMemoryLog1Port();
const updateService = new UpdateSubmissionService(port);
const feedbackService = new FeedbackService(port);

const print = (label: string, value: unknown): void => {
  process.stdout.write(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}\n`);
};

const run = async (): Promise<void> => {
  const help = await routeSlashCommand({
    payload: { command: "/log1", text: "help", user_id: "UDEMO", team_id: "TDEMO" },
    actor,
    port,
    commandId: makeStableCommandId("demo-help"),
  });
  print("/log1 help", help);

  const updateCommandId = commandId("demo-update");
  const updateOpen = await routeSlashCommand({
    payload: { command: "/log1", text: "update Alex Rivera", user_id: "UDEMO", team_id: "TDEMO", trigger_id: "demo-update-trigger" },
    actor,
    port,
    commandId: updateCommandId,
  });
  print("/log1 update Alex Rivera", updateOpen);

  const candidate = await port.getSubmission(actor, seededSubmissionIds.alex);
  if (!candidate.ok) {
    throw new Error(candidate.error.message);
  }
  const updateView = buildUpdateSubmissionModal(candidate.value, updateCommandId);
  const updateInteraction = {
    type: "view_submission",
    user: { id: "UDEMO" },
    team: { id: "TDEMO" },
    view: {
      ...updateView,
      state: {
        values: {
          status_input: { status: { type: "static_select", action_id: "status", selected_option: { value: "onsite" } } },
          note_input: { note: { type: "plain_text_input", action_id: "note", value: "Panel loop confirmed by recruiting." } },
        },
      },
    },
  };
  const parsedUpdate = parseModalSubmission(updateInteraction, actor);
  if (!parsedUpdate.ok || parsedUpdate.value.kind !== "update_submission") {
    throw new Error(parsedUpdate.ok ? "Unexpected modal command." : parsedUpdate.error.message);
  }
  const updated = await updateService.execute(parsedUpdate.value);
  print("update result", updated);
  print("duplicate update result (same command id)", await updateService.execute(parsedUpdate.value));

  const feedbackCommandId = commandId("demo-feedback");
  const feedbackCandidate = await port.getSubmission(actor, seededSubmissionIds.alex);
  if (!feedbackCandidate.ok) {
    throw new Error(feedbackCandidate.error.message);
  }
  const interview = feedbackCandidate.value.interviews[0];
  if (interview === undefined) {
    throw new Error("Seeded candidate has no interview.");
  }
  const feedbackView = buildFeedbackModal(feedbackCandidate.value, interview, feedbackCommandId);
  const feedbackInteraction = {
    type: "view_submission",
    user: { id: "UDEMO" },
    team: { id: "TDEMO" },
    view: {
      ...feedbackView,
      state: {
        values: {
          coding_input: { coding: { type: "static_select", action_id: "coding", selected_option: { value: "no" } } },
          final_round_input: { final_round: { type: "static_select", action_id: "final_round", selected_option: { value: "no" } } },
          recommendation_input: { recommendation: { type: "static_select", action_id: "recommendation", selected_option: { value: "yes" } } },
          score_input: { score: { type: "static_select", action_id: "score", selected_option: { value: "4" } } },
          strengths_input: { strengths: { type: "plain_text_input", action_id: "strengths", value: "Clear systems thinking." } },
          concerns_input: { concerns: { type: "plain_text_input", action_id: "concerns", value: "Needs deeper hiring-process examples." } },
          notes_input: { notes: { type: "plain_text_input", action_id: "notes", value: "Advance to references." } },
        },
      },
    },
  };
  const parsedFeedback = parseModalSubmission(feedbackInteraction, actor);
  if (!parsedFeedback.ok || parsedFeedback.value.kind !== "record_feedback") {
    throw new Error(parsedFeedback.ok ? "Unexpected feedback command." : parsedFeedback.error.message);
  }
  print("feedback result", await feedbackService.execute(parsedFeedback.value));
};

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
