import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A real HTTP server standing in for a customer's endpoint. `respond` decides
 * the status and body; every request is kept in `received`.
 */
export class Receiver {
  readonly received: ReceivedRequest[] = [];
  respond: () => { status: number; body?: string } = () => ({ status: 200, body: "ok" });
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        this.received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        const { status, body } = this.respond();
        res.writeHead(status).end(body);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hooks`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}
