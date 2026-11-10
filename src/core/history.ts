// Undo/redo stack. Entries carry their own undo/redo closures and a byte cost; the
// oldest entries are dropped once the total passes the memory budget.

export interface HistoryEntry {
  label: string;
  /** Lets entries be dropped when a target goes away (e.g. an object is deleted). */
  targets?: string[];
  bytes: number;
  undo(): void;
  redo(): void;
  /** Rewrites stored slot values after palette slots were removed or reordered. */
  remapSlots?(lut: Uint8Array): void;
}

export class History {
  private done: HistoryEntry[] = [];
  private undone: HistoryEntry[] = [];
  private bytes = 0;

  constructor(private budgetBytes = 512 * 1024 * 1024) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }
  get canRedo(): boolean {
    return this.undone.length > 0;
  }
  get undoLabel(): string | null {
    return this.done.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.undone.at(-1)?.label ?? null;
  }
  get size(): number {
    return this.bytes;
  }

  /** Records an action that has already been applied. Clears the redo stack. */
  push(e: HistoryEntry): void {
    for (const u of this.undone) this.bytes -= u.bytes;
    this.undone = [];
    this.done.push(e);
    this.bytes += e.bytes;
    while (this.bytes > this.budgetBytes && this.done.length > 1) {
      this.bytes -= this.done.shift()!.bytes;
    }
  }

  undo(): HistoryEntry | null {
    const e = this.done.pop();
    if (!e) return null;
    e.undo();
    this.undone.push(e);
    return e;
  }

  redo(): HistoryEntry | null {
    const e = this.undone.pop();
    if (!e) return null;
    e.redo();
    this.done.push(e);
    return e;
  }

  /** Removes every entry touching a target (its data is gone or was rebuilt). */
  drop(target: string): void {
    const keep = (e: HistoryEntry) => {
      if (!e.targets?.includes(target)) return true;
      this.bytes -= e.bytes;
      return false;
    };
    this.done = this.done.filter(keep);
    this.undone = this.undone.filter(keep);
  }

  remapSlots(lut: Uint8Array): void {
    for (const e of [...this.done, ...this.undone]) e.remapSlots?.(lut);
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.bytes = 0;
  }
}
