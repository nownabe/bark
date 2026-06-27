import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { InstallGate, type InstallGateProps } from "../entrypoints/review/components/InstallGate";

afterEach(() => {
  cleanup();
});

function makeProps(overrides: Partial<InstallGateProps> = {}): InstallGateProps {
  return {
    owner: "acme",
    repo: "site",
    prNum: "42",
    authMethod: "app",
    loading: false,
    installUrl: "https://github.com/apps/bark/installations/new",
    onRetry: () => {},
    onClearToken: () => {},
    ...overrides,
  };
}

describe("InstallGate — heading", () => {
  test("always shows the brand chrome and the owner/repo #num the user is blocked on", () => {
    const { container } = render(<InstallGate {...makeProps()} />);
    expect(container.querySelector(".gate__brand h1")?.textContent).toBe("Bark");
    expect(container.textContent).toContain("acme/site #42");
  });
});

describe("InstallGate — auth method 'app'", () => {
  test("shows the install CTA, the retry button, and a 'Use a different account' link", () => {
    const onRetry = mock(() => {});
    const onClearToken = mock(() => {});
    const { container } = render(
      <InstallGate {...makeProps({ authMethod: "app", onRetry, onClearToken })} />,
    );
    const install = container.querySelector("a.btn--primary") as HTMLAnchorElement;
    expect(install.textContent).toBe("Install on this repository");
    expect(install.getAttribute("href")).toBe("https://github.com/apps/bark/installations/new");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement;
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    const useDifferent = container.querySelector("button.linkish") as HTMLButtonElement;
    fireEvent.click(useDifferent);
    expect(onClearToken).toHaveBeenCalledTimes(1);
  });

  test("with no installUrl configured (empty BARK_GITHUB_APP_SLUG), the install link is hidden", () => {
    const { container } = render(<InstallGate {...makeProps({ installUrl: null })} />);
    expect(container.querySelector("a.btn--primary")).toBeNull();
  });

  test("Retry shows a 'Checking…' label while loading", () => {
    const { container } = render(<InstallGate {...makeProps({ loading: true })} />);
    const retry = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Checking"),
    ) as HTMLButtonElement;
    expect(retry?.disabled).toBe(true);
  });
});

describe("InstallGate — auth method 'pat'", () => {
  test("shows the PAT-specific copy and a 'Use a different token' button (no install CTA)", () => {
    const onClearToken = mock(() => {});
    const { container } = render(
      <InstallGate {...makeProps({ authMethod: "pat", onClearToken })} />,
    );
    expect(container.textContent).toContain("This token can't access acme/site");
    expect(container.querySelector("a.btn--primary")).toBeNull();
    const useDifferent = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Use a different token",
    ) as HTMLButtonElement;
    fireEvent.click(useDifferent);
    expect(onClearToken).toHaveBeenCalledTimes(1);
  });
});
