import { describe, expect, it } from "vitest";
import { parseProviderQuotaClockReset } from "./provider-quota-reset.js";

const now = new Date("2026-11-18T17:53:00.000Z");
const limit = (clock: string) =>
  `You've hit your org's monthly spend limit · ask your admin to raise it · your session limit resets ${clock} (UTC)`;

describe("parseProviderQuotaClockReset with a damaged clock", () => {
  it("reads an intact clock as the next matching time", () => {
    expect(parseProviderQuotaClockReset(limit("6:20pm"), now)?.toISOString()).toBe("2026-11-18T18:20:00.000Z");
    expect(parseProviderQuotaClockReset(limit("3pm"), now)?.toISOString()).toBe("2026-11-19T15:00:00.000Z");
    expect(parseProviderQuotaClockReset("try again at 23:31", now)?.toISOString()).toBe("2026-11-18T23:31:00.000Z");
  });

  it("does not read the hour alone when redaction removed part of the minutes", () => {
    // Production, 2026-11-18: this was read as 06:00 the next day, a 12 hour hold.
    expect(parseProviderQuotaClockReset(limit("6:2***REDACTED***pm"), now)).toBeNull();
    expect(parseProviderQuotaClockReset(limit("6:***REDACTED***pm"), now)).toBeNull();
  });

  it("does not read a truncated hour when redaction removed one of its digits", () => {
    expect(parseProviderQuotaClockReset(limit("1***REDACTED***pm"), now)).toBeNull();
    expect(parseProviderQuotaClockReset(limit("1***REDACTED***:30pm"), now)).toBeNull();
  });

  it("does not read a clock with a malformed minute field", () => {
    expect(parseProviderQuotaClockReset(limit("6:2pm"), now)).toBeNull();
    expect(parseProviderQuotaClockReset(limit("6:205pm"), now)).toBeNull();
  });
});
