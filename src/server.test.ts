import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createScopedEnvTokenResolver, parseModalOrigin, startServer } from "./server";
import { InMemoryLog1Port } from "./log1-port";
import type { SlackApi } from "./slack";

const slackApi: SlackApi = {
  async viewsOpen() { return { viewId: "test-view" }; },
  async viewsUpdate() {},
  async postEphemeral() {},
};

const request = async (server: ReturnType<typeof createServer>, path: string): Promise<Response> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server did not bind to a TCP address.");
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
};

test("production health fails closed when no Log1 port is injected", async () => {
  const server = createServer({
    mode: "production",
    signingSecret: "secret",
    authResolver: () => "token",
    slackApi,
  });
  const response = await request(server, "/health");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test("production health accepts an explicit Log1 port", async () => {
  const server = createServer({
    mode: "production",
    signingSecret: "secret",
    authResolver: () => "token",
    slackApi,
    log1Port: new InMemoryLog1Port(),
  });
  const response = await request(server, "/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("startServer wires the live adapter in production mode", async () => {
  const environmentKeys = ["LOGGY_MODE", "PORT", "SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN_T_T1", "LOG1_ACTOR_TOKEN_T_T1"] as const;
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  let server: ReturnType<typeof createServer> | undefined;
  try {
    delete process.env.LOGGY_MODE;
    delete process.env.PORT;
    process.env.SLACK_SIGNING_SECRET = "secret";
    process.env.SLACK_BOT_TOKEN_T_T1 = "xoxb-test";
    process.env.LOG1_ACTOR_TOKEN_T_T1 = "log1-test";
    server = startServer(0);
    await new Promise<void>((resolve, reject) => {
      server?.once("listening", () => resolve());
      server?.once("error", reject);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind to a TCP address.");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  } finally {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => server?.close((error) => error === undefined ? resolve() : reject(error)));
    }
    for (const key of environmentKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("workspace token resolver never falls back across workspaces", () => {
  const environment = {
    SLACK_BOT_TOKEN_T_ALLOWED: "xoxb-scoped",
    SLACK_BOT_TOKEN: "xoxb-global",
    SLACK_BOT_TOKEN_WORKSPACE_ID: "T_PINNED",
  };
  const resolve = createScopedEnvTokenResolver("SLACK_BOT_TOKEN", environment);
  assert.equal(resolve("T_ALLOWED"), "xoxb-scoped");
  assert.equal(resolve("T_PINNED"), "xoxb-global");
  assert.equal(resolve("T_OTHER"), undefined);
});

test("modal origin is accepted only when it matches the signed Slack identity", () => {
  const payload = {
    type: "view_submission",
    user: { id: "U1" },
    team: { id: "T1" },
    view: {
      private_metadata: JSON.stringify({
        kind: "update",
        commandId: "cmd-1",
        submissionId: "sub-1",
        expectedVersion: 1,
        origin: { workspaceId: "T1", userId: "U1", channelId: "C1" },
      }),
    },
  };
  assert.deepEqual(parseModalOrigin(payload), { workspaceId: "T1", userId: "U1", channelId: "C1" });
  assert.equal(parseModalOrigin({ ...payload, user: { id: "U2" } }), undefined);
  assert.equal(parseModalOrigin({ ...payload, team: { id: "T2" } }), undefined);
});
