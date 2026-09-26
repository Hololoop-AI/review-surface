import { appendFile, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { AsyncMutex } from "./async-mutex.js";

// The page graph: typed links between review pages, and the one query that filters them.
//
// Pages are the sessions in state.json - every page ever opened, by anyone. Links live in their
// own append-only `links.jsonl` beside it, one `{type, from, to, at}` record per line, `from`
// and `to` being session keys. Nothing is ever rewritten: a later `child-of` for the same page
// is a move, so the latest record wins. The link write path is the only thing that appends, and
// it refuses anything that would make the graph unreadable - a nesting cycle, a supersede cycle,
// a page replaced by two pages, an unknown type, a self-link, or a page name that matches more
// than one page.
//
// A page's state is DERIVED from what the session store recorded (ended, queued feedback, who
// spoke last, when anything last moved), never from its title or file name. A title is display
// and search text only: a page titled "DECIDED" whose agent still owes a reply is agent-working.
export const LINK_TYPES = Object.freeze(["child-of", "supersedes", "derived-from"]);
export const PAGE_STATES = Object.freeze(["needs-you", "agent-working", "new", "quiet", "ended"]);
export const SEARCH_KINDS = Object.freeze(["page", "feedback", "reply", "event"]);
export const REPLACED_FILTERS = Object.freeze(["no", "yes", "any"]);
// No activity for this long and nobody's turn: the page folds away as quiet, never deleted.
export const QUIET_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const TITLE_READ_BYTES = 16 * 1024;

export function linksFile(stateFile, env = process.env) {
  return env.REVIEW_SURFACE_LINKS || path.join(path.dirname(stateFile), "links.jsonl");
}

export class LinkError extends Error {
  /** @param {string} message @param {"VALIDATION_ERROR" | "NOT_FOUND" | "REFUSED"} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** @returns {Promise<any[]>} link records oldest first; a torn line is skipped */
export async function readLinkRecords(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (LINK_TYPES.includes(record?.type) && record.from && record.to) records.push(record);
    } catch {
      // a torn trailing line from a concurrent append
    }
  }
  return records;
}

export function buildGraph(records) {
  const parent = new Map();
  const replacedBy = new Map();
  const derived = [];
  for (const record of records) {
    if (record.type === "child-of") parent.set(record.from, record.to);
    else if (record.type === "supersedes") replacedBy.set(record.to, record.from);
    else derived.push([record.from, record.to]);
  }
  return { parent, replacedBy, derived };
}

export function ancestors(parent, key) {
  const seen = [];
  let node = key;
  while (parent.has(node)) {
    node = parent.get(node);
    if (node === key || seen.includes(node)) break;
    seen.push(node);
  }
  return seen;
}

/**
 * Resolve a page reference to a session key: an exact session key, an exact file path, or a
 * file-path suffix that ends on a path boundary and matches exactly one page.
 * @param {any[]} sessions
 * @param {string} ref
 */
export function resolvePageRef(sessions, ref) {
  const wanted = String(ref || "").trim();
  if (!wanted) throw new LinkError("A page reference is required", "VALIDATION_ERROR");
  const byKey = sessions.find((session) => session.key === wanted);
  if (byKey) return byKey.key;
  const suffix = wanted.replace(/^[/\\]+/, "");
  const hits = sessions.filter(
    (session) => session.file === wanted || session.file.endsWith(`/${suffix}`) || session.file.endsWith(`\\${suffix}`),
  );
  if (hits.length === 1) return hits[0].key;
  if (hits.length === 0) {
    throw new LinkError(`No page matches '${wanted}'; open it with review-surface first`, "NOT_FOUND");
  }
  throw new LinkError(
    `'${wanted}' matches ${hits.length} pages; use a session key or a longer path`,
    "VALIDATION_ERROR",
  );
}

/**
 * The link rules. Returns "unchanged" when the exact link is already the recorded one, and
 * throws a LinkError for anything the graph must never hold.
 */
export function checkLink(graph, type, from, to) {
  if (!LINK_TYPES.includes(type)) {
    throw new LinkError(`Link type must be one of ${LINK_TYPES.join(", ")}`, "VALIDATION_ERROR");
  }
  if (from === to) throw new LinkError("A page cannot link to itself", "REFUSED");
  if (type === "child-of") {
    if (graph.parent.get(from) === to) return "unchanged";
    if (ancestors(graph.parent, to).includes(from)) {
      throw new LinkError("Nesting cycle: the parent page is already inside this page", "REFUSED");
    }
    return "new";
  }
  if (type === "supersedes") {
    if (graph.replacedBy.get(to) === from) return "unchanged";
    const seen = new Set();
    for (let node = from; graph.replacedBy.has(node) && !seen.has(node); ) {
      seen.add(node);
      node = graph.replacedBy.get(node);
      if (node === to) throw new LinkError("Supersede cycle: the older page already replaces this one", "REFUSED");
    }
    if (graph.replacedBy.has(to)) {
      throw new LinkError("That page is already replaced by another page", "REFUSED");
    }
    return "new";
  }
  return graph.derived.some(([a, b]) => a === from && b === to) ? "unchanged" : "new";
}

export class LinkStore {
  constructor(file) {
    this.file = file;
    // Every check-then-append runs under this lock, so two writers can never both pass the rules
    // against the same snapshot and together record what either alone would have been refused.
    this.lock = new AsyncMutex();
  }

  read() {
    return readLinkRecords(this.file);
  }

  /**
   * Record one link between two known pages. A page that supersedes another and has no parent of
   * its own takes the older page's place in the tree (a `child-of` to the same parent is recorded
   * with it), so a replaced page never drops its successor out of the project that held it.
   * @param {any[]} sessions
   * @param {{ type: string, from: string, to: string }} link
   */
  record(sessions, { type, from, to }) {
    return this.lock.runExclusive(async () => {
      if (!LINK_TYPES.includes(type)) {
        throw new LinkError(`Link type must be one of ${LINK_TYPES.join(", ")}`, "VALIDATION_ERROR");
      }
      const fromKey = resolvePageRef(sessions, from);
      const toKey = resolvePageRef(sessions, to);
      const graph = buildGraph(await this.read());
      const outcome = checkLink(graph, type, fromKey, toKey);
      const written = [];
      if (outcome === "new") written.push({ type, from: fromKey, to: toKey });
      if (type === "supersedes" && !graph.parent.has(fromKey) && graph.parent.has(toKey)) {
        const inherited = graph.parent.get(toKey);
        try {
          if (checkLink(graph, "child-of", fromKey, inherited) === "new") {
            written.push({ type: "child-of", from: fromKey, to: inherited });
          }
        } catch {
          // the successor is itself an ancestor of that parent; it keeps no inherited place
        }
      }
      const at = new Date().toISOString();
      const records = written.map((link) => ({ ...link, at }));
      if (records.length > 0) {
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
      }
      return {
        status: outcome === "new" ? "recorded" : "unchanged",
        link: { type, from: fromKey, to: toKey },
        records,
      };
    });
  }
}

/**
 * A page's state, from recorded session facts only.
 * @param {any} session
 * @param {number} now epoch ms
 */
export function derivePageState(session, now) {
  if (session.status === "ended") return "ended";
  if ((session.prompts || []).length > 0) return "agent-working";
  const chat = session.chat || [];
  const last = chat.length > 0 ? chat[chat.length - 1].role : null;
  if (last === "user") return "agent-working";
  const updated = Date.parse(session.updated_at || "");
  if (Number.isFinite(updated) && now - updated >= QUIET_AFTER_MS) return "quiet";
  return last === "agent" ? "needs-you" : "new";
}

/** The page's own `<title>`, for display and text search; the file name when it has none. */
export async function readPageTitle(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(TITLE_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buffer.toString("utf8", 0, bytesRead));
    const title = match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
    return { title: title || path.basename(file, path.extname(file)), exists: true };
  } catch {
    return { title: path.basename(file, path.extname(file)), exists: false };
  } finally {
    await handle?.close();
  }
}

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39|apos);/g, (entity) => ENTITIES[entity]);
}
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

/**
 * Validate raw query options (CLI flags or URL params) into queryPages options.
 * @param {{ under?: string, depth?: string, state?: string, text?: string, replaced?: string }} raw
 */
export function parsePageQuery(raw) {
  const options = {};
  if (raw.under) options.under = raw.under;
  if (raw.depth !== undefined && raw.depth !== null && raw.depth !== "") {
    if (!/^\d+$/.test(String(raw.depth))) throw new LinkError("depth must be a whole number", "VALIDATION_ERROR");
    options.depth = Number(raw.depth);
  }
  if (raw.state) {
    const states = String(raw.state)
      .split(",")
      .map((state) => state.trim())
      .filter(Boolean);
    const unknown = states.filter((state) => !PAGE_STATES.includes(state));
    if (unknown.length > 0) {
      throw new LinkError(`Unknown state ${unknown.join(", ")}; use ${PAGE_STATES.join(", ")}`, "VALIDATION_ERROR");
    }
    options.states = states;
  }
  if (raw.text) options.text = String(raw.text);
  if (raw.replaced) {
    if (!REPLACED_FILTERS.includes(raw.replaced)) {
      throw new LinkError(`replaced must be one of ${REPLACED_FILTERS.join(", ")}`, "VALIDATION_ERROR");
    }
    options.replaced = raw.replaced;
  }
  return options;
}

/**
 * Every page, with its derived state and its links. Pure over its inputs.
 * @param {{ sessions: any[], records: any[], titles: Map<string, { title: string, exists: boolean }>, now: number }} input
 * @param {{ under?: string, depth?: number, states?: string[], text?: string, replaced?: string }} [options]
 */
export function queryPages({ sessions, records, titles, now }, options = {}) {
  const graph = buildGraph(records);
  const root = options.under ? resolvePageRef(sessions, options.under) : null;
  const replaced = options.replaced || "no";
  const text = options.text?.toLowerCase();
  const children = new Map();
  for (const [child, parent] of graph.parent) children.set(parent, [...(children.get(parent) || []), child]);
  const out = [];
  for (const session of sessions) {
    if (session.key === root) continue;
    const chain = ancestors(graph.parent, session.key);
    if (root && !chain.includes(root)) continue;
    const depth = root ? chain.indexOf(root) + 1 : chain.length;
    if (options.depth !== undefined && depth > options.depth) continue;
    const isReplaced = graph.replacedBy.has(session.key);
    if ((replaced === "no" && isReplaced) || (replaced === "yes" && !isReplaced)) continue;
    const state = derivePageState(session, now);
    if (options.states && !options.states.includes(state)) continue;
    const { title, exists } = titles.get(session.key) || { title: path.basename(session.file), exists: false };
    if (text && !`${title} ${session.file}`.toLowerCase().includes(text)) continue;
    out.push({
      key: session.key,
      file: session.file,
      title,
      state,
      updated_at: session.updated_at || null,
      exists,
      depth,
      links: {
        parent: graph.parent.get(session.key) || null,
        children: children.get(session.key) || [],
        replaced_by: graph.replacedBy.get(session.key) || null,
        replaces: [...graph.replacedBy].filter(([, next]) => next === session.key).map(([old]) => old),
        derived_from: graph.derived.filter(([from]) => from === session.key).map(([, to]) => to),
      },
    });
  }
  // Shallowest first, then most recently active first.
  return out.sort((a, b) => a.depth - b.depth || String(b.updated_at).localeCompare(String(a.updated_at)));
}

/**
 * One raw search across everything Review Surface records, ignoring the hierarchy: pages
 * (replaced ones included), the feedback journal, agent replies, and the event log.
 * @param {{ pages: any[], sessions: any[], journal: any[], events: any[] }} input
 * @param {string} query
 * @param {{ kinds?: string[] }} [options]
 */
export function searchEverything({ pages, sessions, journal, events }, query, { kinds } = {}) {
  const needle = String(query || "").toLowerCase();
  const want = (kind) => !kinds || kinds.includes(kind);
  const rows = [];
  if (want("page")) {
    for (const page of pages) {
      rows.push({
        kind: "page",
        key: page.key,
        file: page.file,
        title: page.title,
        state: page.state,
        at: page.updated_at,
        text: page.links.replaced_by ? "replaced" : "",
      });
    }
  }
  if (want("feedback")) {
    for (const batch of journal) {
      rows.push({
        kind: "feedback",
        key: batch.key || "",
        file: batch.file || "",
        title: path.basename(batch.file || ""),
        state: "sent",
        at: batch.at || null,
        text: (batch.prompts || []).map((prompt) => prompt.prompt || "").join(" | "),
      });
    }
  }
  if (want("reply")) {
    for (const session of sessions) {
      for (const message of session.chat || []) {
        if (message.role !== "agent") continue;
        rows.push({
          kind: "reply",
          key: session.key,
          file: session.file,
          title: path.basename(session.file),
          state: "",
          at: message.at || null,
          text: message.text || "",
        });
      }
    }
  }
  if (want("event")) {
    for (const event of events) {
      rows.push({
        kind: "event",
        key: event.subject || "",
        file: event.data?.file || "",
        title: event.type || "",
        state: "",
        at: event.ts || null,
        text: JSON.stringify(event.data || {}),
      });
    }
  }
  const hits = needle
    ? rows.filter((row) =>
        Object.values(row).some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(needle),
        ),
      )
    : rows;
  return hits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Load everything the query and search read, straight from the state directory's files. */
export async function loadPageGraphInputs({ store, linksPath, eventsPath, now = Date.now() }) {
  const sessions = await store.listSessions();
  const titles = new Map(await Promise.all(sessions.map(async (s) => [s.key, await readPageTitle(s.file)])));
  return { sessions, records: await readLinkRecords(linksPath), titles, now, eventsPath, store };
}

export async function loadSearchSources(inputs) {
  const pages = queryPages(inputs, { replaced: "any" });
  const [journal, events] = await Promise.all([readJsonl(inputs.store.journalFile), readJsonl(inputs.eventsPath)]);
  return { pages, sessions: inputs.sessions, journal, events };
}

async function readJsonl(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // torn line
    }
  }
  return out;
}

/** A CLI page reference that names an existing file is sent as its canonical path. */
export async function canonicalPageRef(ref) {
  try {
    return await realpath(path.resolve(ref));
  } catch {
    return ref;
  }
}
