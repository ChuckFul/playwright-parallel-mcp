import { describe, expect, it } from "vitest";
import { checkCdpEndpoint } from "../src/preflight.js";

describe("preflight CDP check", () => {
  it("should return false for a port with nothing listening", async () => {
    const result = await checkCdpEndpoint("http://127.0.0.1:19999");
    expect(result.listening).toBe(false);
  });

  it("should return error message for dead port", async () => {
    const result = await checkCdpEndpoint("http://127.0.0.1:19999");
    expect(result.error).toContain("not listening");
  });

  it("should validate URL format", async () => {
    const result = await checkCdpEndpoint("not-a-url");
    expect(result.listening).toBe(false);
    expect(result.error).toBeDefined();
  });
});
