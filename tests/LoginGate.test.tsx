import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { LoginGate } from "../entrypoints/review/components/LoginGate";

// Validate the real lib/pat by stubbing global fetch. We deliberately do NOT
// mock.module("../lib/pat") — bun's module mock is process-global and would
// strip PatError from the module for pat.test.ts running in the same process.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: () => Promise<Response> | Response) {
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

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
    stubFetch(() => jsonResponse(401, {}));
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
    stubFetch(() => jsonResponse(200, { login: "octocat", avatar_url: "" }));
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
