import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RESPONSE_BODY_LIMIT, send } from "./send";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

describe("send", () => {
  let server: Server;
  let url: string;
  let handler: Handler;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const request = { headers: { "content-type": "application/json", "x-test": "1" }, body: "{}" };

  it("POSTs the body and headers and reports the response", async () => {
    let seen: { method?: string; header?: string | string[]; body?: string } = {};
    handler = (req, res, body) => {
      seen = { method: req.method, header: req.headers["x-test"], body };
      res.writeHead(201).end("thanks");
    };

    const result = await send({ url, ...request });
    expect(seen).toEqual({ method: "POST", header: "1", body: "{}" });
    expect(result).toEqual({
      statusCode: 201,
      durationMs: expect.any(Number),
      responseBody: "thanks",
      error: null,
    });
  });

  it("reports non-2xx responses as they are", async () => {
    handler = (_req, res) => res.writeHead(503).end("busy");
    expect(await send({ url, ...request })).toMatchObject({
      statusCode: 503,
      responseBody: "busy",
      error: null,
    });
  });

  it("keeps only the first 4 KB of the response body", async () => {
    handler = (_req, res) => res.writeHead(200).end("x".repeat(RESPONSE_BODY_LIMIT * 3));
    const result = await send({ url, ...request });
    expect(result.responseBody).toHaveLength(RESPONSE_BODY_LIMIT);
  });

  it("strips NUL characters, which Postgres text cannot store", async () => {
    handler = (_req, res) => res.writeHead(200).end("a\u0000b");
    expect((await send({ url, ...request })).responseBody).toBe("ab");
  });

  it("does not follow redirects", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits += 1;
      res.writeHead(307, { location: url }).end();
    };
    expect(await send({ url, ...request })).toMatchObject({ statusCode: 307 });
    expect(hits).toBe(1);
  });

  it("gives up after the timeout and says so", async () => {
    handler = () => undefined; // never answers
    const result = await send({ url, ...request }, { timeoutMs: 200 });
    expect(result).toEqual({
      statusCode: null,
      durationMs: expect.any(Number),
      responseBody: null,
      error: "timed out after 200 ms",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(190);
  });

  it("reports connection errors with their cause", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const result = await send({ url: `http://127.0.0.1:${port}/`, ...request });
    expect(result.statusCode).toBeNull();
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
