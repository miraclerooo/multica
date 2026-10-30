import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enAuth from "../locales/en/auth.json";
import { PasswordSignIn } from "./password-sign-in";

function show(onLogin: (email: string, password: string, token?: string) => Promise<void>) {
  return render(<I18nProvider locale="en" resources={{ en: { auth: enAuth } }}><PasswordSignIn onLogin={onLogin} /></I18nProvider>);
}

describe("password sign in", () => {
  it("uses a password without sending a verification code", async () => {
    window.history.replaceState(null, "", "/login");
    const login = vi.fn().mockResolvedValue(undefined);
    show(login);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.type(screen.getByLabelText("Password"), "a long test password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("owner@example.com", "a long test password", undefined));
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
  });

  it("captures a setup capability without retaining it in the URL and checks confirmation", async () => {
    window.history.replaceState(null, "", "/login#password-setup=one-time-test-capability");
    const login = vi.fn().mockResolvedValue(undefined);
    show(login);
    const user = userEvent.setup();
    expect(window.location.hash).toBe("");
    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.type(screen.getByLabelText("Password"), "a long test password");
    await user.type(screen.getByLabelText("Confirm password"), "another long password");
    await user.click(screen.getByRole("button", { name: "Save and sign in" }));
    expect(login).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match.");
    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(screen.getByLabelText("Confirm password"), "a long test password");
    await user.click(screen.getByRole("button", { name: "Save and sign in" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("owner@example.com", "a long test password", "one-time-test-capability"));
  });
});
