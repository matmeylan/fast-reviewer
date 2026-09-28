import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import UpdateButton, { CHECK_INTERVAL_MS } from "./UpdateButton";
import type { AvailableUpdate, Updater } from "../lib/updater";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fakeUpdater(update: AvailableUpdate | null): Updater & { checks: number } {
  const u = {
    checks: 0,
    check: async () => {
      u.checks++;
      return update;
    },
  };
  return u;
}

describe("UpdateButton", () => {
  it("renders nothing without an updater or when up to date", async () => {
    const none = render(() => <UpdateButton updater={null} onError={() => {}} />);
    expect(none.queryByTestId("update-button")).toBeNull();

    const updater = fakeUpdater(null);
    const upToDate = render(() => <UpdateButton updater={updater} onError={() => {}} />);
    await waitFor(() => expect(updater.checks).toBe(1));
    expect(upToDate.queryByTestId("update-button")).toBeNull();
  });

  it("offers the new version and installs it in one click, showing progress", async () => {
    let finish!: () => void;
    let report!: (f: number | null) => void;
    const install = vi.fn(
      (onProgress?: (f: number | null) => void) =>
        new Promise<void>((resolve) => {
          report = onProgress!;
          finish = resolve;
        }),
    );
    const { findByTestId } = render(() => (
      <UpdateButton updater={fakeUpdater({ version: "0.1.43", install })} onError={() => {}} />
    ));
    const button = await findByTestId("update-button");
    expect(button.textContent).toBe("Update to 0.1.43");

    fireEvent.click(button);
    expect(install).toHaveBeenCalledOnce();
    expect(button.textContent).toBe("Updating…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    report(0.42);
    expect(button.textContent).toBe("Updating… 42%");

    // A second click while installing does nothing.
    fireEvent.click(button);
    expect(install).toHaveBeenCalledOnce();
    finish();
  });

  it("reports a failed install and lets the user retry", async () => {
    const onError = vi.fn();
    const install = vi.fn(async () => {
      throw new Error("signature mismatch");
    });
    const { findByTestId } = render(() => (
      <UpdateButton updater={fakeUpdater({ version: "0.1.43", install })} onError={onError} />
    ));
    const button = await findByTestId("update-button");
    fireEvent.click(button);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Couldn't install update: signature mismatch"));
    expect(button.textContent).toBe("Update to 0.1.43");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("checks again periodically until an update shows up", async () => {
    vi.useFakeTimers();
    let latest: AvailableUpdate | null = null;
    const updater = {
      checks: 0,
      check: async () => {
        updater.checks++;
        return latest;
      },
    };
    const { queryByTestId } = render(() => <UpdateButton updater={updater} onError={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.checks).toBe(1);
    expect(queryByTestId("update-button")).toBeNull();

    latest = { version: "0.1.44", install: async () => {} };
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(2);
    expect(queryByTestId("update-button")?.textContent).toBe("Update to 0.1.44");

    // Once found, it stops asking.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(2);
  });
});
