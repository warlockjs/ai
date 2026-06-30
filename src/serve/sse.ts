/**
 * Encode one Server-Sent-Events frame. Multi-line `data` is split into
 * multiple `data:` lines per the SSE spec, so JSON with embedded newlines
 * still parses on the client.
 *
 * @example
 * encodeSSE({ event: "agent.trip.streaming", data: { delta: "Hi" } });
 * // "event: agent.trip.streaming\ndata: {\"delta\":\"Hi\"}\n\n"
 */
export function encodeSSE(frame: { event?: string; data: unknown; id?: string }): string {
  let out = "";
  if (frame.id) out += `id: ${frame.id}\n`;
  if (frame.event) out += `event: ${frame.event}\n`;

  const data =
    typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
  for (const line of data.split("\n")) {
    out += `data: ${line}\n`;
  }

  out += "\n";
  return out;
}

/** The terminal SSE frame a client watches for to stop reading. */
export const SSE_DONE = "data: [DONE]\n\n";
