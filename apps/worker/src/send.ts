/** A receiver gets this long to answer, body included, before the attempt fails. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Only the first 4 KB of a response body is kept. */
export const RESPONSE_BODY_LIMIT = 4096;

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** What one HTTP attempt produced, ready to be stored as a delivery attempt. */
export interface SendResult {
  /** HTTP status, or null when no response arrived. */
  statusCode: number | null;
  durationMs: number;
  /** Up to RESPONSE_BODY_LIMIT bytes of the response, or null without one. */
  responseBody: string | null;
  /** Why no response arrived, or null when one did. */
  error: string | null;
  /** The response's Retry-After header as sent, or null without one. */
  retryAfter: string | null;
}

export interface SendOptions {
  timeoutMs?: number;
}

/**
 * POSTs one webhook. Never throws: network errors and timeouts become a
 * result with `statusCode: null` so the caller can record them like any other
 * attempt. Redirects are not followed; a 3xx is reported as it is, because
 * following one would send the signed payload somewhere the endpoint owner
 * did not register.
 */
export async function send(
  request: WebhookRequest,
  options: SendOptions = {},
): Promise<SendResult> {
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal,
    });
    const responseBody = await readCapped(response, RESPONSE_BODY_LIMIT);
    return {
      statusCode: response.status,
      durationMs: elapsed(),
      responseBody,
      error: null,
      retryAfter: response.headers.get("retry-after"),
    };
  } catch (error) {
    return {
      statusCode: null,
      durationMs: elapsed(),
      responseBody: null,
      error: signal.aborted ? `timed out after ${timeoutMs} ms` : describeError(error),
      retryAfter: null,
    };
  }
}

/**
 * Reads at most `limit` bytes and stops, so a huge or endless response cannot
 * exhaust memory. If the body fails part-way (timeout, reset) the status has
 * already arrived, so what was read so far is kept rather than failing the
 * attempt.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // Keep the bytes that did arrive.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks).subarray(0, limit);
  // Postgres text cannot hold NUL; a cut multi-byte character decodes to U+FFFD.
  return new TextDecoder().decode(bytes).replaceAll("\u0000", "");
}

/**
 * fetch() wraps the useful part ("connect ECONNREFUSED ...") in `cause`.
 * Duck-typed rather than `instanceof Error`, which fails across realms.
 */
function describeError(error: unknown): string {
  const message = messageOf(error);
  const cause = messageOf((error as { cause?: unknown } | null)?.cause);
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

function messageOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "message" in value) {
    const { message } = value as { message: unknown };
    if (typeof message === "string" && message) return message;
  }
  return value === undefined ? "" : String(value);
}
