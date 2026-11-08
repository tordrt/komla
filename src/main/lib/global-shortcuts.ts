import { GLOBAL_SHORTCUT_ACTIONS } from '../../shared/constants/shortcut-scopes';
import { toAccelerator } from '../../shared/lib/global-shortcut-accelerator';

import type { GlobalShortcut } from 'electron';

type GlobalShortcutApi = Pick<GlobalShortcut, 'register' | 'unregister'>;

/**
 * Keeps the system-wide registrations in step with the shortcuts config. The system can refuse
 * keys, such as ones another app holds; those actions are then unavailable until the user saves
 * shortcuts again, rather than asked for on every reload of the config.
 */
export class GlobalShortcuts {
  private registered = new Map<string, string>();
  /** The keys the system refused, by action. */
  private refused = new Map<string, string>();
  private disposed = false;

  constructor(
    private api: GlobalShortcutApi,
    private platform: NodeJS.Platform,
    private onPress: (action: string) => void
  ) {}

  /** `retryRefused` asks again for keys the system refused, as when the user saves shortcuts. */
  apply(shortcuts: Record<string, string>, { retryRefused = false } = {}): void {
    if (this.disposed) return;
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      const keys = shortcuts[action] ?? '';
      const accelerator = toAccelerator(keys, this.platform);
      // The same keys in another order make the same accelerator.
      const identity = accelerator ?? keys;
      const current = this.registered.get(action);
      if (accelerator && accelerator === current) continue;
      const refusedAgain = !retryRefused && this.refused.get(action) === identity;
      if (!current && keys && refusedAgain) continue;

      if (current) this.api.unregister(current);
      this.registered.delete(action);
      this.refused.delete(action);
      if (!keys) continue;

      if (accelerator && this.register(accelerator, action)) {
        this.registered.set(action, accelerator);
      } else {
        this.refused.set(action, identity);
      }
    }
  }

  /** Actions with keys the system wouldn't take. */
  unavailableActions(): string[] {
    return [...this.refused.keys()];
  }

  /** Gives every key back for good, as Komla quits: later changes register nothing. */
  dispose(): void {
    this.disposed = true;
    for (const accelerator of this.registered.values()) this.api.unregister(accelerator);
    this.registered.clear();
    this.refused.clear();
  }

  private register(accelerator: string, action: string): boolean {
    try {
      return this.api.register(accelerator, () => this.onPress(action));
    } catch {
      // Electron throws on an accelerator it can't parse.
      return false;
    }
  }
}
