import { appendFile, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";

// The event log: ONE append-only JSONL stream of what happened to review pages, pushed to any
// subscriber. Every line is the same envelope {ts, source, type, subject, data}, with `subject`
// the session key and `data.file` the artifact path, so a host app never needs a key -> file
// lookup. Review Surface emits it and knows nothing about who listens; a host that keeps its own
// log (a blackboard, a board file) relays from here.
//
// The cursor a subscriber resumes from is a BYTE OFFSET into the file, the end of the last line
// it saw. An append-only file makes that monotonic with no counter to persist across restarts,
// and a process that tails the file directly uses the same number.
//
// Metadata only: feedback text stays in the feedback journal and agent replies in the session
// chat. The log says that something happened and where, never what anyone wrote.
export const EVENT_SOURCE = "review-surface";

export function eventLogFile(stateFile, env = process.env) {
  return env.REVIEW_SURFACE_EVENTS || path.join(path.dirname(stateFile), "events.jsonl");
}

export class EventLog {
  constructor(file) {
    this.file = file;
    // Every append and every subscribe runs on this chain, so a subscriber's replay of
    // [cursor, end) and its switch to live delivery cannot interleave with a write: nothing is
    // delivered twice and nothing lands in the gap.
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
    this.size = null;
    /** @type {Set<(event: object, cursor: number) => void>} */
    this.listeners = new Set();
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  #enqueue(task) {
    const run = this.chain.then(task);
    this.chain = run.catch(() => {});
    return run;
  }

  async #ensureSize() {
    if (this.size !== null) return;
    try {
      this.size = (await stat(this.file)).size;
    } catch {
      this.size = 0;
    }
  }

  /**
   * Append one event and push it to live subscribers. Best-effort by design, like the feedback
   * outbox: the log must never fail the request that produced the event, so a write failure
   * returns null and the next append re-reads the file size.
   * @param {string} type
   * @param {string} subject
   * @param {Record<string, unknown>} [data]
   */
  append(type, subject, data = {}) {
    return this.#enqueue(async () => {
      const event = { ts: new Date().toISOString(), source: EVENT_SOURCE, type, subject, data };
      const line = `${JSON.stringify(event)}\n`;
      try {
        await this.#ensureSize();
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, line);
      } catch {
        this.size = null;
        return null;
      }
      this.size += Buffer.byteLength(line);
      const cursor = this.size;
      for (const listener of this.listeners) {
        try {
          listener(event, cursor);
        } catch {
          // one broken subscriber must not starve the others
        }
      }
      return { event, cursor };
    });
  }

  /**
   * Attach a subscriber. With `after` (a cursor from an earlier event), every event past it is
   * replayed from disk first; without it, delivery is live only. A cursor past the end of the
   * file means the log was replaced, so the whole file replays.
   * @param {(event: object, cursor: number) => void} listener
   * @param {{ after?: number | null }} [options]
   * @returns {Promise<() => void>} unsubscribe
   */
  subscribe(listener, { after = null } = {}) {
    return this.#enqueue(async () => {
      await this.#ensureSize();
      if (after !== null && Number.isFinite(after) && after >= 0) {
        const start = after > this.size ? 0 : after;
        for (const { event, cursor } of await this.#readRange(start, this.size)) listener(event, cursor);
      }
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });
  }

  async #readRange(start, end) {
    if (end <= start) return [];
    let handle;
    try {
      handle = await open(this.file, "r");
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const out = [];
      let offset = start;
      for (const line of buffer.toString("utf8").split("\n")) {
        offset += Buffer.byteLength(line) + 1;
        if (!line.trim()) continue;
        try {
          out.push({ event: JSON.parse(line), cursor: Math.min(offset, end) });
        } catch {
          // a torn line (a crash mid-append, or a cursor that was not a line boundary) is skipped
        }
      }
      return out;
    } catch {
      return [];
    } finally {
      await handle?.close();
    }
  }
}
