import { describe, expect, it } from "vitest";
import { isMicrosoftEntraAuthorizationHost } from "../services/tool-access/oauth/entra.js";

// Generic MCP OAuth adds prompt=consent when offline_access is requested, except
// for Microsoft Entra: there it overrides an existing admin grant and blocks
// every non-admin user in tenants that restrict user consent.
describe("isMicrosoftEntraAuthorizationHost", () => {
  it.each([
    "login.microsoftonline.com",
    "LOGIN.MICROSOFTONLINE.COM",
    "login.windows.net",
    "login.microsoftonline.us",
    "login.partner.microsoftonline.cn",
  ])("treats %s as Entra", (host) => {
    expect(isMicrosoftEntraAuthorizationHost(host)).toBe(true);
  });

  it.each([
    "accounts.google.com",
    "auth.example.com",
    "login.microsoftonline.com.evil.example",
    "evil-login.microsoftonline.com",
    "microsoftonline.com",
  ])("does not treat %s as Entra", (host) => {
    expect(isMicrosoftEntraAuthorizationHost(host)).toBe(false);
  });
});
