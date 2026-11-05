import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { WebSocketServer } from "ws";
import type { Coordinator } from "./coordinator.js";
import type { ServiceRegistry } from "./services.js";
import type { Requirements, ProvisionOptions } from "./types.js";

/** Per-attempt RPC handle. Disposing it releases the coordinator allocation. */
export class Allocation extends RpcTarget {
  constructor(private readonly handle: ReturnType<Coordinator["open"]>) {
    super();
  }
  ready() {
    return this.handle.ready();
  }
  release() {
    return this.handle.release();
  }
  [Symbol.dispose]() {
    void this.handle.release();
  }
}

export class ProvisionEndpoint extends RpcTarget {
  constructor(
    private readonly current: () => Coordinator,
    private readonly services?: ServiceRegistry,
  ) {
    super();
  }
  open(testId: string, requirements: Requirements, attempt: number) {
    return new Allocation(this.current().open(testId, requirements, attempt));
  }
  getService(key: string): Promise<unknown> {
    if (!this.services) throw new Error("Service RPC is not configured");
    return this.services.get(key);
  }
  async activate(testId: string, requirements: Requirements) {
    this.current().activate(testId, 0, requirements);
  }
  async prefetchRetry(testId: string, retry: number) {
    this.current().prefetchRetry(testId, retry);
  }
}

/** RPC endpoint for provisioning. */
export class RpcServer {
  #server: WebSocketServer | undefined;
  url: string | undefined;

  constructor(
    private readonly current: () => Coordinator,
    private readonly options: Pick<ProvisionOptions, "listenHost" | "advertiseHost"> = {},
    private readonly services?: ServiceRegistry,
  ) {}

  async start() {
    if (this.url) return;
    const token = randomUUID();
    const host = this.options.listenHost ?? "127.0.0.1";
    const server = new WebSocketServer({
      host,
      port: 0,
      // Allow large test specifications while bounding inbound message memory.
      maxPayload: 16 * 1024 * 1024,
    });
    this.#server = server;
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No WebSocket address");
    }
    const publicHost = this.options.advertiseHost ?? host;
    const hostname =
      publicHost.includes(":") && !publicHost.startsWith("[") ? `[${publicHost}]` : publicHost;
    this.url = `ws://${hostname}:${address.port}/${token}`;
    server.on("connection", (socket, request) => {
      if (request.url !== `/${token}`) {
        socket.close(1008);
        return;
      }
      newWebSocketRpcSession(socket as unknown as WebSocket, new ProvisionEndpoint(this.current, this.services), {
        onSendError: (error) => error,
      });
    });
  }

  async close() {
    if (!this.#server) return;
    const server = this.#server;
    this.#server = undefined;
    this.url = undefined;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
