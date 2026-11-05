import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { ProvisionEndpoint } from "./server.js";

const sessions = new Map<string, RpcStub<ProvisionEndpoint>>();

export function getSession(url: string): RpcStub<ProvisionEndpoint> {
  const cached = sessions.get(url);
  if (cached) return cached;

  const session = newWebSocketRpcSession<ProvisionEndpoint>(url);
  sessions.set(url, session);
  session.onRpcBroken(() => {
    // A broken session cannot be reused. Do not evict a newer replacement.
    if (sessions.get(url) !== session) return;
    sessions.delete(url);
    session[Symbol.dispose]();
  });

  return session;
}
