import { describe, expect, it } from "vitest";
import {
  isAuthFailureMessage,
  isMcpOAuthRequiredMessage,
  mcpOAuthRequiredHost,
} from "./login.js";

const VERCEL_MCP = `Agent process exited (code=143, signal=null): 2026-09-03T00:19:17.251272Z ERROR worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\\"invalid_token\\", error_description=\\"No authorization provided\\", resource_metadata=\\"https://mcp.vercel.com/.well-known/oauth-protected-resource\\"" })`;

describe("isMcpOAuthRequiredMessage", () => {
  it("detects Vercel MCP AuthRequired (the NightMoose false-positive)", () => {
    expect(isMcpOAuthRequiredMessage(VERCEL_MCP)).toBe(true);
    expect(mcpOAuthRequiredHost(VERCEL_MCP)).toBe("mcp.vercel.com");
  });

  it("is false for a real Grok CLI login prompt", () => {
    expect(isMcpOAuthRequiredMessage("please run /login")).toBe(false);
  });
});

describe("isAuthFailureMessage", () => {
  it("does not treat MCP OAuth as NightMoose / Grok profile login", () => {
    expect(isAuthFailureMessage(VERCEL_MCP)).toBe(false);
    expect(isAuthFailureMessage("oauth-protected-resource invalid_token")).toBe(false);
  });

  it("still matches real CLI login failures", () => {
    expect(isAuthFailureMessage("please run /login")).toBe(true);
    expect(isAuthFailureMessage("Not logged in to Anthropic")).toBe(true);
    expect(isAuthFailureMessage("failed to authenticate with xAI")).toBe(true);
    expect(isAuthFailureMessage("OAuth token missing or revoked")).toBe(true);
    expect(isAuthFailureMessage("HTTP 401 unauthorized")).toBe(true);
  });

  it("does not match a bare oauth mention in a normal reply", () => {
    expect(isAuthFailureMessage("I'll lock one login at a time and stop the OAuth flow")).toBe(
      false,
    );
  });
});
