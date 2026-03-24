import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig, McpToolCallResult } from "../src/types.js";

const createdConfigs: BackendConfig[] = [];
const originalPresets = process.env.BROWSER_PRESETS;

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
}

async function loadSessionManager(presets?: string) {
  vi.resetModules();
  createdConfigs.length = 0;

  if (presets === undefined) {
    delete process.env.BROWSER_PRESETS;
  } else {
    process.env.BROWSER_PRESETS = presets;
  }

  vi.doMock("../src/mcp-client.js", () => ({
    McpClient: MockMcpClient
  }));

  vi.doMock("../src/preflight.js", () => ({
    checkCdpEndpoint: vi.fn(async () => ({ listening: true }))
  }));

  return import("../src/session-manager.js");
}

afterEach(() => {
  if (originalPresets === undefined) {
    delete process.env.BROWSER_PRESETS;
  } else {
    process.env.BROWSER_PRESETS = originalPresets;
  }
});

describe("preset system", () => {
  it("should resolve a configured preset", async () => {
    const { sessionManager } = await loadSessionManager(
      JSON.stringify({
        webview2: {
          cdpEndpoint: "http://127.0.0.1:9222"
        }
      })
    );

    expect(sessionManager.getPresets()).toEqual({
      webview2: {
        cdpEndpoint: "http://127.0.0.1:9222"
      }
    });
    expect(sessionManager.resolvePreset("webview2")).toEqual({
      cdpEndpoint: "http://127.0.0.1:9222"
    });
  });

  it("should return undefined for unknown preset", async () => {
    const { sessionManager } = await loadSessionManager(
      JSON.stringify({
        chrome: {
          cdpEndpoint: "http://127.0.0.1:9333"
        }
      })
    );

    expect(sessionManager.resolvePreset("nonexistent")).toBeUndefined();
  });

  it("should use preset backend version pinning and cdpEndpoint for new sessions", async () => {
    const { sessionManager } = await loadSessionManager(
      JSON.stringify({
        outlook: {
          cdpEndpoint: "http://127.0.0.1:9445",
          backend: "@playwright/mcp@0.0.68"
        }
      })
    );

    const session = await sessionManager.createSession({ preset: "outlook" } as any);

    expect(session.backend).toBe("@playwright/mcp@0.0.68");
    expect(session.cdpEndpoint).toBe("http://127.0.0.1:9445");
    expect(session.preset).toBe("outlook");
    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0].args).toEqual([
      "@playwright/mcp@0.0.68",
      "--cdp-endpoint",
      "http://127.0.0.1:9445"
    ]);
  });
});
