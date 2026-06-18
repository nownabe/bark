import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, mock, test } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";

// Mock PAT validation; resolves or rejects per-test via validateImpl.
let validateImpl: (token: string) => Promise<{ login: string; avatarUrl: string }>;
mock.module("../lib/pat", () => ({
  validatePat: (token: string) => validateImpl(token),
}));

const { LoginGate } = await import("../entrypoints/review/components/LoginGate");

function baseProps() {
  return {
    owner: "o",
    repo: "r",
    prNum: "7",
    deviceAuth: null,
    authStarting: false,
    authError: null,
    onStartDeviceFlow: () => {},
    onAuthenticated: () => {},
  };
}

describe("LoginGate", () => {
  test("choose screen shows both methods and the shared privacy note", () => {
    const { container } = render(<LoginGate {...baseProps()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("GitHub App");
    expect(text).toContain("Token");
    expect(text.toLowerCase()).toContain("stored only in this browser");
  });

  test("choosing the token method reveals setup steps and a password input", () => {
    const { container } = render(<LoginGate {...baseProps()} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-test='choose-pat']")!);
    expect(container.querySelector("input[type='password']")).not.toBeNull();
    expect((container.textContent ?? "").toLowerCase()).toContain("read and write");
  });

  test("an invalid token surfaces the error and keeps the entered value", async () => {
    validateImpl = () => Promise.reject(new Error("Token is invalid or expired."));
    const { container } = render(<LoginGate {...baseProps()} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-test='choose-pat']")!);
    const input = container.querySelector<HTMLInputElement>("input[type='password']")!;
    fireEvent.change(input, { target: { value: "ghp_bad" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-test='pat-save']")!);
    await waitFor(() =>
      expect(container.querySelector(".notice--error")?.textContent).toContain("invalid"),
    );
    expect(container.querySelector<HTMLInputElement>("input[type='password']")!.value).toBe(
      "ghp_bad",
    );
  });

  test("a valid token calls onAuthenticated with the token and 'pat'", async () => {
    validateImpl = () => Promise.resolve({ login: "octocat", avatarUrl: "" });
    let got: [string, string] | null = null;
    const props = {
      ...baseProps(),
      onAuthenticated: (t: string, m: string) => {
        got = [t, m];
      },
    };
    const { container } = render(<LoginGate {...props} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-test='choose-pat']")!);
    const input = container.querySelector<HTMLInputElement>("input[type='password']")!;
    fireEvent.change(input, { target: { value: "  ghp_good  " } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-test='pat-save']")!);
    await waitFor(() => expect(got).not.toBeNull());
    expect(got).toEqual(["ghp_good", "pat"]);
  });

  test("choosing the app method then going back returns to the choose screen", () => {
    const { container } = render(<LoginGate {...baseProps()} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-test='choose-app']")!);
    expect(container.querySelector("[data-test='pat-save']")).toBeNull();
    expect(container.textContent ?? "").toContain("Connect GitHub");
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-test='back']")!);
    expect(container.querySelector("[data-test='choose-pat']")).not.toBeNull();
  });
});
