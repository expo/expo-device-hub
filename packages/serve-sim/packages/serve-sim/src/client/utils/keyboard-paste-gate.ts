/** Coordinates a browser paste event with the V keyup that follows it. */
export class KeyboardPasteGate {
  private waiting = false;

  get isWaiting(): boolean { return this.waiting; }

  start(): void { this.waiting = true; }

  cancel(): void { this.waiting = false; }

  /** Repeats are still the original held shortcut key, even after its modifier is released. */
  onVKeyDown(repeat: boolean): boolean {
    if (!this.waiting) return false;
    if (repeat) return true;
    // A fresh physical V press means the shortcut's keyup was lost.
    this.waiting = false;
    return false;
  }

  paste(text: string): "text" | "fallback" | "ignore" {
    const wasWaiting = this.waiting;
    this.waiting = false;
    return text ? "text" : wasWaiting ? "fallback" : "ignore";
  }

  release(vAlreadyForwarded: boolean): "fallback" | "release" | "ignore" {
    if (!this.waiting) return "ignore";
    this.waiting = false;
    return vAlreadyForwarded ? "release" : "fallback";
  }
}
