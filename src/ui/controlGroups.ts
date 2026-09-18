import type { InputState } from '@/shared/types';

export const CONTROL_GROUP_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
export type ControlGroupKey = typeof CONTROL_GROUP_KEYS[number];
export interface ControlGroupAction { key: ControlGroupKey; assign: boolean }
export interface ControlGroupSlot { key: ControlGroupKey; count: number; active: boolean }

/** The recorded chord survives a modifier released between two rendered frames. */
export function controlGroupKeyAction(input: Pick<InputState, 'keysPressed' | 'keysDown'>): ControlGroupAction | null {
  if (input.keysDown.has('alt') || input.keysDown.has('shift')) return null;
  for (const key of CONTROL_GROUP_KEYS) {
    const chord = input.keysPressed.has(`mod+${key}`);
    if (chord || input.keysPressed.has(key)) {
      return { key, assign: chord || input.keysDown.has('control') || input.keysDown.has('meta') };
    }
  }
  return null;
}

/** Groups belong to this battle screen and retain the primary team's selection order. */
export class ControlGroups {
  private members = new Map<ControlGroupKey, number[]>();
  private preferredKey: ControlGroupKey | null = null;

  assign(key: ControlGroupKey, selection: readonly number[]): void {
    const ids = [...new Set(selection)];
    if (ids.length > 0) this.members.set(key, ids);
    else this.members.delete(key);
    this.preferredKey = key;
  }

  /** Missing, enemy, and out-of-action teams cannot remain in a group. */
  prune(selectable: ReadonlySet<number>): void {
    for (const [key, ids] of this.members) {
      const survivors = ids.filter((id) => selectable.has(id));
      if (survivors.length > 0) this.members.set(key, survivors);
      else this.members.delete(key);
    }
  }

  /** An empty group is a no-op, preserving the current selection. */
  recall(key: ControlGroupKey): number[] | null {
    const ids = this.members.get(key);
    if (!ids?.length) return null;
    this.preferredKey = key;
    return [...ids];
  }

  slots(selection: readonly number[]): ControlGroupSlot[] {
    const selected = new Set(selection);
    const matches = (key: ControlGroupKey): boolean => {
      const ids = this.members.get(key);
      return !!ids?.length && ids.length === selected.size && ids.every((id) => selected.has(id));
    };
    const active = this.preferredKey && matches(this.preferredKey)
      ? this.preferredKey : CONTROL_GROUP_KEYS.find(matches);
    return CONTROL_GROUP_KEYS.map((key) => ({ key, count: this.members.get(key)?.length ?? 0, active: key === active }));
  }
}
