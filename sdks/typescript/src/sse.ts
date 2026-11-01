import { ConnectionError } from "./errors.js";

export interface SSEMessage {
  /** Event name; `message` when the stream did not name one. */
  event: string;
  /** Data lines joined with newlines. */
  data: string;
  id?: string;
}

/**
 * Parse a server-sent-events byte stream into messages. Handles chunk
 * boundaries anywhere (including inside a CRLF pair), CR, LF and CRLF line
 * endings, multi-line data, comments, and a final event with no trailing
 * blank line. Cancels the underlying stream when the consumer stops early.
 *
 * `idleMs` is the longest silence tolerated between two chunks (the server sends a heartbeat every
 * 10 seconds): past it the stream is cancelled and a timeout ConnectionError is thrown.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  idleMs?: number,
): AsyncGenerator<SSEMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let eventId: string | undefined;
  let dataLines: string[] = [];
  const ready: SSEMessage[] = [];

  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (idleMs === undefined) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ConnectionError(`No data from the stream for ${idleMs} ms`, { category: "timeout" })),
        idleMs,
      );
    });
    return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
  };

  const dispatch = (): void => {
    if (dataLines.length > 0) {
      const message: SSEMessage = {
        event: eventName === "" ? "message" : eventName,
        data: dataLines.join("\n"),
      };
      if (eventId !== undefined) message.id = eventId;
      ready.push(message);
    }
    eventName = "";
    eventId = undefined;
    dataLines = [];
  };

  const handleLine = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") eventId = value;
  };

  try {
    for (;;) {
      const { done, value } = await read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      const lineEnd = /\r\n|\n|\r/g;
      let pos = 0;
      for (;;) {
        lineEnd.lastIndex = pos;
        const match = lineEnd.exec(buffer);
        if (match === null) break;
        // A lone CR at the very end may be the first half of a CRLF.
        if (match[0] === "\r" && match.index + 1 === buffer.length && !done) break;
        handleLine(buffer.slice(pos, match.index));
        pos = match.index + match[0].length;
      }
      buffer = buffer.slice(pos);

      if (done) {
        if (buffer !== "") handleLine(buffer);
        dispatch();
      }
      while (ready.length > 0) {
        const next = ready.shift();
        if (next !== undefined) yield next;
      }
      if (done) return;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed or errored; nothing to release.
    }
  }
}
