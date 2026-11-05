import type { RpcStub } from "capnweb";
import type { ProvisionEndpoint } from "./server.js";
import type { Accessor, Requirements, ResourceContract, ResourceRequest, ServiceContract } from "./types.js";

/** Resolve declared test resources and shared services, disposing acquired RPC handles on exit. */
export class PreparedScope {
  readonly #handles: { [Symbol.dispose](): void }[] = [];
  #disposed = false;

  constructor(
    private readonly values: Record<string, unknown>,
    private readonly requirements: Requirements,
    private readonly connect: () => RpcStub<ProvisionEndpoint>,
  ) {}

  readonly prepared: Accessor = ((
    reference: ResourceRequest | ResourceContract<any, unknown> | ServiceContract<unknown>,
    alias?: string,
  ) => {
    if (this.#disposed) throw new Error("Prepared scope has been released");
    if ("alias" in reference) {
      if (alias !== undefined) throw new TypeError("A request already has an alias");
      alias = reference.alias;
    } else if (reference.kind === "service") {
      if (alias !== undefined) throw new TypeError("Services do not have aliases");
      const handle = this.connect().getService(reference.key);
      this.#handles.push(handle);
      return handle;
    }
    if (typeof alias !== "string" || !alias) {
      throw new TypeError("prepared(resource, alias) requires a nonempty alias");
    }
    if (!Object.hasOwn(this.requirements, alias)) {
      throw new Error(`Resource '${alias}' was not declared for this test`);
    }
    const entry = this.requirements[alias];
    if (entry.key !== reference.key) {
      throw new TypeError(`Resource '${alias}' has type '${entry.key}', not '${reference.key}'`);
    }
    if (!Object.hasOwn(this.values, alias)) {
      throw new Error(`Declared resource '${alias}' was not returned by the coordinator`);
    }
    return this.values[alias];
  }) as Accessor;

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const handle of this.#handles.splice(0)) handle[Symbol.dispose]();
  }
}
