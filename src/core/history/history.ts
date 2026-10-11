/**
 * Snapshot undo history. Projects are immutable (immer), so each entry is
 * just a reference and unchanged subtrees are shared between snapshots.
 *
 * Interactive gestures (dragging a keyframe, scrubbing a value) open a
 * transaction: intermediate states replace each other and only the state at
 * `begin` is pushed once the gesture ends, giving one undo step per gesture.
 */
export interface HistoryEntry<T> {
  state: T;
  label: string;
}

export class History<T> {
  private past: HistoryEntry<T>[] = [];
  private future: HistoryEntry<T>[] = [];
  private txn: { base: T; label: string } | null = null;

  constructor(private readonly limit = 200) {}

  /** Record that `prev` was replaced by a new state. */
  push(prev: T, label: string): void {
    if (this.txn) return;
    this.past.push({ state: prev, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  begin(current: T, label: string): void {
    if (this.txn) return;
    this.txn = { base: current, label };
  }

  /** Close the transaction. Pushes an entry only if the state changed. */
  end(current: T): void {
    const txn = this.txn;
    this.txn = null;
    if (txn && txn.base !== current) this.push(txn.base, txn.label);
  }

  get inTransaction(): boolean {
    return this.txn !== null;
  }

  undo(current: T): T | null {
    if (this.txn) this.end(current);
    const e = this.past.pop();
    if (!e) return null;
    this.future.push({ state: current, label: e.label });
    return e.state;
  }

  redo(current: T): T | null {
    const e = this.future.pop();
    if (!e) return null;
    this.past.push({ state: current, label: e.label });
    return e.state;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.future[this.future.length - 1]?.label ?? null;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.txn = null;
  }
}
