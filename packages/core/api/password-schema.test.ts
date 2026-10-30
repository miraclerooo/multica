// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient } from "./client";
import { setSchemaLogger } from "./schema";
import { noopLogger } from "../logger";
import { AppConfigSchema, PasswordLoginResponseSchema } from "./schemas";

describe("password authentication contracts", () => {
  it("does not enable password mode for old or malformed configuration", () => {
    expect(AppConfigSchema.parse({}).password_login).toBe(false);
    expect(AppConfigSchema.parse({ password_login: "yes" }).password_login).toBe(false);
    expect(AppConfigSchema.parse({ password_login: true }).password_login).toBe(true);
  });
  it("rejects incomplete sessions instead of accepting an empty token or user", () => {
    for (const value of [null, {}, { token: "", user: {} }, { token: "secret", user: { id: "", email: "owner@example.com" } }]) {
      expect(PasswordLoginResponseSchema.safeParse(value).success).toBe(false);
    }
    expect(PasswordLoginResponseSchema.safeParse({ token: "test-token", user: { id: "test-user", email: "owner@example.com" } }).success).toBe(true);
  });
});

afterEach(() => { vi.unstubAllGlobals(); setSchemaLogger(noopLogger); });

it("rejects malformed login responses without logging the returned token", async () => {
  const warn = vi.fn();
  setSchemaLogger({ ...noopLogger, warn });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "sensitive-test-session", user: null }), { status: 200 })));
  await expect(new ApiClient("https://api.example.test").passwordLogin("owner@example.com", "test-password")).rejects.toThrow("Invalid sign-in response");
  expect(warn).toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive-test-session");
});
