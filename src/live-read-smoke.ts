import { authenticatedActor } from "./domain";
import { RealLog1Port } from "./real-log1-port";

const token = process.env.LOG1_SMOKE_TOKEN?.trim();
const workspaceId = process.env.LOG1_SMOKE_WORKSPACE_ID?.trim() ?? "live-smoke";
const actorId = process.env.LOG1_SMOKE_ACTOR_ID?.trim() ?? "live-smoke";
const query = process.env.LOG1_SMOKE_QUERY?.trim() ?? "";

const run = async (): Promise<void> => {
  if (token === undefined || token.length === 0) {
    process.stderr.write("Set LOG1_SMOKE_TOKEN to run the read-only Log1 smoke check.\n");
    process.exitCode = 2;
    return;
  }
  const port = new RealLog1Port();
  const result = await port.findSubmissions(authenticatedActor({ actorId, workspaceId, accessToken: token }), query);
  if (!result.ok) {
    process.stderr.write(`${result.error.kind}: ${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ count: result.value.length, submissions: result.value.map((item) => ({ id: item.id, candidateName: item.candidateName, status: item.status, interviewCount: item.interviews.length })) })}\n`);
  }
};

void run().catch(() => {
  process.stderr.write("The live Log1 smoke check failed.\n");
  process.exitCode = 1;
});
