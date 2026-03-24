import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionManager } from "../src/session-manager.js";
import type { Session } from "../src/session-manager.js";
import type { McpToolCallResult } from "../src/types.js";

const PAGE_HTML = "<!DOCTYPE html><html><body><h1>Snapshot Heading</h1><p>Snapshot body</p></body></html>";
const PAGE_URL = `data:text/html,${encodeURIComponent(PAGE_HTML)}`;

function getTextContent(result: McpToolCallResult): string {
  return result.content
    .filter(item => item.type === "text")
    .map(item => item.text ?? "")
    .join("\n");
}

describe("Snapshot", () => {
  let session: Session;

  beforeAll(async () => {
    session = await sessionManager.createSession();
    await sessionManager.callTool(session.id, "browser_navigate", { url: PAGE_URL });
  });

  afterAll(async () => {
    await sessionManager.closeSession(session.id);
  });

  it("should return an accessibility snapshot through the wrapped tool", async () => {
    const result = await sessionManager.callTool(session.id, "browser_snapshot", {});
    const text = getTextContent(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain(`Page URL: ${PAGE_URL}`);
    expect(text).toContain('heading "Snapshot Heading"');
  });

  it("should return screenshot text metadata and image content", async () => {
    const result = await sessionManager.callTool(session.id, "browser_take_screenshot", { type: "png" });
    const text = getTextContent(result);
    const image = result.content.find(item => item.type === "image");

    expect(result.isError).not.toBe(true);
    expect(text).toContain("Screenshot of viewport");
    expect(image).toMatchObject({
      type: "image",
      mimeType: "image/png"
    });
    expect(image?.data?.length ?? 0).toBeGreaterThan(0);
  });
});
