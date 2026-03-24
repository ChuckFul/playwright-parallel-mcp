import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionManager } from "../src/session-manager.js";
import type { Session } from "../src/session-manager.js";
import type { McpToolCallResult } from "../src/types.js";

const PAGE_HTML = "<!DOCTYPE html><html><head><title>Nav Title</title></head><body><h1>Hello</h1></body></html>";
const PAGE_URL = `data:text/html,${encodeURIComponent(PAGE_HTML)}`;

function getTextContent(result: McpToolCallResult): string {
  return result.content
    .filter(item => item.type === "text")
    .map(item => item.text ?? "")
    .join("\n");
}

function parseJsonResult<T>(result: McpToolCallResult): T {
  const text = getTextContent(result);
  const match = text.match(/### Result\n([\s\S]*?)\n### Ran Playwright code/);
  if (!match) {
    throw new Error(`Expected JSON result block, received: ${text}`);
  }

  return JSON.parse(match[1]) as T;
}

describe("Navigation", () => {
  let session: Session;

  beforeAll(async () => {
    session = await sessionManager.createSession();
  });

  afterAll(async () => {
    await sessionManager.closeSession(session.id);
  });

  it("should navigate through the wrapped browser_navigate tool", async () => {
    const result = await sessionManager.callTool(session.id, "browser_navigate", { url: PAGE_URL });
    const text = getTextContent(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain(`Page URL: ${PAGE_URL}`);
    expect(text).toContain("Page Title: Nav Title");
    expect(text).toContain('heading "Hello"');
  });

  it("should preserve page state for subsequent wrapped tool calls", async () => {
    await sessionManager.callTool(session.id, "browser_navigate", { url: PAGE_URL });

    const result = await sessionManager.callTool(session.id, "browser_run_code", {
      code: "async (page) => ({ title: await page.title(), url: page.url() })"
    });

    const value = parseJsonResult<{ title: string; url: string }>(result);
    expect(value).toEqual({
      title: "Nav Title",
      url: PAGE_URL
    });
  });
});
