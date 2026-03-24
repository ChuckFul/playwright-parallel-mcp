import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig, McpToolCallResult } from "../src/types.js";

const createdConfigs: BackendConfig[] = [];

class MockMcpClient extends EventEmitter {
  constructor(private readonly config: BackendConfig) {
    super();
    createdConfigs.push(config);
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.emit("exit", 0);
  }

  getTools() {
    return [];
  }

  async callTool(): Promise<McpToolCallResult> {
    return { content: [] };
  }

  isRunning(): boolean {
    return true;
  }
}

vi.mock("../src/mcp-client.js", () => ({
  McpClient: MockMcpClient
}));

vi.mock("../src/preflight.js", () => ({
  checkCdpEndpoint: vi.fn(async () => ({ listening: true }))
}));

const { sessionManager } = await import("../src/session-manager.js");

describe("CDP endpoint support", () => {
  afterEach(async () => {
    createdConfigs.length = 0;
    await sessionManager.closeAllSessions();
  });

  it("should append --cdp-endpoint to spawned child args", async () => {
    const session = await sessionManager.createSession({
      cdpEndpoint: "http://127.0.0.1:9222"
    } as any);

    expect(session).toBeDefined();
    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0].args).toEqual([
      "@playwright/mcp@latest",
      "--cdp-endpoint",
      "http://127.0.0.1:9222"
    ]);
  });

  it("should leave backend args unchanged when cdpEndpoint is omitted", async () => {
    await sessionManager.createSession();

    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0].args).toEqual(["@playwright/mcp@latest"]);
  });
});
