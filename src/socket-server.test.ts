import test from "node:test";
import assert from "node:assert/strict";
import { createSocketModeApp, startSocketModeApps, workspaceIdsFromEnvironment } from "./socket-server";

test("resolves an explicit multi-workspace Socket Mode list", () => {
  assert.deepEqual(
    workspaceIdsFromEnvironment({ LOGGY_WORKSPACES: " T03L0CDPMFA, T07AYH279GU " }),
    ["T03L0CDPMFA", "T07AYH279GU"],
  );
});

test("rejects duplicate or malformed workspace IDs", () => {
  assert.throws(
    () => workspaceIdsFromEnvironment({ LOGGY_WORKSPACES: "T1,T1" }),
    /duplicate Slack workspace IDs/,
  );
  assert.throws(
    () => workspaceIdsFromEnvironment({ LOGGY_WORKSPACES: "T1,not valid" }),
    /invalid Slack workspace ID/,
  );
});

test("infers all workspace IDs from scoped app tokens", () => {
  assert.deepEqual(
    workspaceIdsFromEnvironment({
      SLACK_APP_TOKEN_T03L0CDPMFA: "xapp-consultadd",
      SLACK_APP_TOKEN_T07AYH279GU: "xapp-caps",
    }),
    ["T03L0CDPMFA", "T07AYH279GU"],
  );
});

test("keeps legacy single-workspace configuration compatible", () => {
  assert.deepEqual(workspaceIdsFromEnvironment({ SLACK_WORKSPACE_ID: "T123" }), ["T123"]);
  assert.deepEqual(workspaceIdsFromEnvironment({ LOGGY_WORKSPACE_ID: "T456" }), ["T456"]);
});

test("requires scoped credentials for each selected workspace", () => {
  assert.throws(
    () => createSocketModeApp({
      workspaceId: "T_CONSULTADD",
      environment: {
        SLACK_BOT_TOKEN_T_CONSULTADD: "xoxb-consultadd",
        LOG1_ACTOR_TOKEN_T_CONSULTADD: "log1-consultadd",
      },
    }),
    /configured/,
  );
});

test("rolls back every worker when one workspace fails to start", async () => {
  const calls: string[] = [];
  const worker = (name: string, failure?: "init" | "start") => ({
    async init(): Promise<void> {
      calls.push(`${name}:init`);
      if (failure === "init") throw new Error(`${name} init failed`);
    },
    async start(): Promise<void> {
      calls.push(`${name}:start`);
      if (failure === "start") throw new Error(`${name} start failed`);
    },
    async stop(): Promise<void> {
      calls.push(`${name}:stop`);
    },
  });

  await assert.rejects(
    startSocketModeApps([worker("consultadd"), worker("caps", "start")]),
    /caps start failed/,
  );
  assert.deepEqual(calls, [
    "consultadd:init",
    "consultadd:start",
    "caps:init",
    "caps:start",
    "consultadd:stop",
    "caps:stop",
  ]);
});
