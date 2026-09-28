// Self-update through the Tauri updater plugin. The app checks the manifest of the
// latest GitHub release (see plugins > updater in src-tauri/tauri.conf.json), and
// installing replaces the app in place, then relaunches it.
import { isTauri } from "./api";

export interface AvailableUpdate {
  version: string;
  /** Downloads, verifies and installs the update, then relaunches the app.
   *  `onProgress` gets the downloaded fraction, or null while the size is unknown. */
  install(onProgress?: (fraction: number | null) => void): Promise<void>;
}

export interface Updater {
  /** The newer version the latest release offers, or null when up to date. */
  check(): Promise<AvailableUpdate | null>;
  /** Calls `fn` when the user picks "Check for Updates…" in the app menu. Returns an unsubscribe. */
  onCheckRequested?(fn: () => void): () => void;
}

/** Emitted by the app menu item (see src-tauri/src/lib.rs). */
const CHECK_UPDATES_EVENT = "check-for-updates";

function tauriUpdater(): Updater {
  return {
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        async install(onProgress) {
          let total = 0;
          let done = 0;
          await update.downloadAndInstall((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? 0;
              onProgress?.(total ? 0 : null);
            } else if (event.event === "Progress") {
              done += event.data.chunkLength;
              onProgress?.(total ? Math.min(1, done / total) : null);
            }
          });
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        },
      };
    },
    onCheckRequested(fn) {
      let stop: (() => void) | null = null;
      let stopped = false;
      import("@tauri-apps/api/event")
        .then(({ listen }) => listen(CHECK_UPDATES_EVENT, () => fn()))
        .then(
          (unlisten) => (stopped ? unlisten() : (stop = unlisten)),
          (e) => console.warn("Couldn't listen for update checks:", e),
        );
      return () => {
        stopped = true;
        stop?.();
      };
    },
  };
}

/** The updater for this build, or null where updating makes no sense: outside
 *  Tauri (browser, tests) and in dev builds, which aren't installed apps. */
export function getUpdater(): Updater | null {
  return isTauri() && !import.meta.env.DEV ? tauriUpdater() : null;
}
