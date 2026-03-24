import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionManager } from "../src/session-manager.js";
import type { Session } from "../src/session-manager.js";
import type { McpToolCallResult } from "../src/types.js";

const PAGE_URL = "data:text/html,%3Chtml%3E%3Cbody%3Eready%3C/body%3E%3C/html%3E";

function getTextContent(result: McpToolCallResult): string {
  return result.content
    .filter(item => item.type === "text")
    .map(item => item.text ?? "")
    .join("\n");
}

describe("Console Logs", () => {
  let session: Session;

  beforeAll(async () => {
    session = await sessionManager.createSession();
    await sessionManager.callTool(session.id, "browser_navigate", { url: PAGE_URL });
  });

  afterAll(async () => {
    await sessionManager.closeSession(session.id);
  });

  it("should return console output captured by the wrapped backend", async () => {
    const suffix = Date.now().toString();
    const logMessage = `log-${suffix}`;
    const errorMessage = `error-${suffix}`;
    const warningMessage = `warning-${suffix}`;

    await sessionManager.callTool(session.id, "browser_evaluate", {
      function: `() => {
        console.log(${JSON.stringify(logMessage)});
        console.error(${JSON.stringify(errorMessage)});
        console.warn(${JSON.stringify(warningMessage)});
        return document.body.textContent;
      }`
    });

    const result = await sessionManager.callTool(session.id, "browser_console_messages", { level: "info" });
    const text = getTextContent(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain(logMessage);
    expect(text).toContain(errorMessage);
    expect(text).toContain(warningMessage);
    expect(text).toContain("[ERROR]");
    expect(text).toContain("[WARNING]");
  });
});
