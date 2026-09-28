import { createSignal, onCleanup, onMount, Show } from "solid-js";
import CircleArrowUp from "lucide-solid/icons/circle-arrow-up";
import { errorMessage } from "../lib/store";
import { getUpdater, type AvailableUpdate, type Updater } from "../lib/updater";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

/** How often a running app looks for a new release. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Titlebar button that appears once a newer release is out; one click installs
 *  it and relaunches the app. Releases are checked at startup, every
 *  CHECK_INTERVAL_MS, and on demand from the app menu ("Check for Updates…"). */
export default function UpdateButton(props: {
  updater?: Updater | null;
  onError: (message: string) => void;
  /** Reports the outcome of a check the user asked for. */
  onInfo?: (message: string) => void;
}) {
  const updater = props.updater === undefined ? getUpdater() : props.updater;
  const [update, setUpdate] = createSignal<AvailableUpdate | null>(null);
  // null: not installing; a number: download fraction; NaN: size unknown.
  const [progress, setProgress] = createSignal<number | null>(null);

  onMount(() => {
    if (!updater) return;
    const check = () => {
      if (update()) return;
      // Offline, rate limited, or no release yet: try again at the next interval.
      updater.check().then(setUpdate, (e) => console.warn("Update check failed:", e));
    };
    check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
    const stop = updater.onCheckRequested?.(() => void checkNow());
    if (stop) onCleanup(stop);
  });

  /** A check the user asked for: unlike the background ones, it always reports back. */
  let checking = false;
  async function checkNow() {
    if (!updater || checking) return;
    const known = update();
    if (known) {
      props.onInfo?.(`Fast Reviewer ${known.version} is available. Click “Update to ${known.version}” to install it.`);
      return;
    }
    checking = true;
    try {
      const found = await updater.check();
      setUpdate(found);
      props.onInfo?.(
        found
          ? `Fast Reviewer ${found.version} is available. Click “Update to ${found.version}” to install it.`
          : "Fast Reviewer is up to date.",
      );
    } catch (e) {
      props.onError(`Couldn't check for updates: ${errorMessage(e)}`);
    } finally {
      checking = false;
    }
  }

  async function install() {
    const u = update();
    if (!u || progress() !== null) return;
    setProgress(NaN);
    try {
      await u.install((f) => setProgress(f ?? NaN));
    } catch (e) {
      setProgress(null);
      props.onError(`Couldn't install update: ${errorMessage(e)}`);
    }
  }

  const label = () => {
    const p = progress();
    if (p === null) return `Update to ${update()!.version}`;
    return Number.isNaN(p) ? "Updating…" : `Updating… ${Math.round(p * 100)}%`;
  };

  return (
    <Show when={update()}>
      <Button
        size="sm"
        class="ml-auto flex-none"
        onClick={install}
        disabled={progress() !== null}
        title="A new version of Fast Reviewer is available. Click to install it and restart."
        data-testid="update-button"
      >
        <Show when={progress() !== null} fallback={<CircleArrowUp />}>
          <Spinner class="text-current" />
        </Show>
        {label()}
      </Button>
    </Show>
  );
}
