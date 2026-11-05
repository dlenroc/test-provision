import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import { test as base } from 'vitest'
import { service, type Prepared } from '../../src/index.js'
import { collectRequirements } from '../../src/core/contract.js'
import { Coordinator } from '../../src/core/coordinator.js'
import { splitProviders } from '../../src/core/provider.js'
import { RpcServer, type ProvisionEndpoint } from '../../src/core/server.js'
import { ServiceRegistry } from '../../src/core/services.js'
import type { ProvisionOptions, ResourceRequest, Requirements } from '../../src/core/types.js'

type RunPlan = Pick<ProvisionOptions, 'providers' | 'concurrency' | 'shutdownTimeout' | 'prefetchRetries'> & {
  tests?: Record<string, readonly ResourceRequest[]>
  skipped?: readonly string[]
  retries?: number
}

type TestIds<Plan extends RunPlan> = Extract<keyof NonNullable<Plan['tests']>, string>
type Connection = RpcStub<ProvisionEndpoint>
type ServiceValue<C> = C extends ReturnType<typeof service> ? Prepared<C> : never
type ResourceValue<C> = C extends (...args: never[]) => infer R
  ? R extends ResourceRequest ? Prepared<R> : never
  : never

/** A second RPC client for checking that services are shared across workers. */
export class TestClient {
  constructor(private readonly connection: Connection) {}

  service<C extends ReturnType<typeof service>>(contract: C): ServiceValue<C> {
    return this.connection.getService(contract.key) as unknown as ServiceValue<C>
  }
}

/**
 * Exercises the real coordinator, service registry, and WebSocket transport.
 * No runner callbacks are faked: runner-specific behavior belongs in CLI fixtures.
 */
export class TestRun<Id extends string = string> {
  readonly events: readonly string[]
  readonly #coordinator: Coordinator
  readonly #services: ServiceRegistry
  readonly #server: RpcServer
  readonly #plans: Map<string, Requirements>
  readonly #retries: number
  readonly #prefetchRetries: boolean
  readonly #connections: Connection[] = []
  readonly #disposal = new AsyncDisposableStack()
  #resourcesStopped = false
  #stopPromise?: Promise<void>

  private constructor(
    coordinator: Coordinator,
    services: ServiceRegistry,
    server: RpcServer,
    plans: Map<string, Requirements>,
    retries: number,
    prefetchRetries: boolean,
    events: string[],
  ) {
    this.#coordinator = coordinator
    this.#services = services
    this.#server = server
    this.#plans = plans
    this.#retries = retries
    this.#prefetchRetries = prefetchRetries
    this.events = events
    this.#disposal.defer(() => this.#server.close())
    this.#disposal.defer(() => this.#services.close())
    this.#disposal.defer(() => this.finishTests())
  }

  static async start<Id extends string>(options: RunPlan, events: string[]): Promise<TestRun<Id>> {
    const plans = new Map(Object.entries(options.tests ?? {})
      .map(([id, requests]) => [id, collectRequirements(requests)] as const))
    const entries = splitProviders(options.providers)
    const services = new ServiceRegistry(entries.services, options.shutdownTimeout)
    const coordinator = new Coordinator(entries.resources,
      { concurrency: { prefetch: 0, ...options.concurrency }, shutdownTimeout: options.shutdownTimeout },
      declaration => services.resolve(declaration))
    const server = new RpcServer(() => coordinator, {}, services)
    const run = new TestRun<Id>(coordinator, services, server, plans, options.retries ?? 0, options.prefetchRetries ?? false, events)

    try {
      await server.start()
      run.connect()
      coordinator.scheduleForecasts([...plans]
        .filter(([id]) => !options.skipped?.includes(id))
        .map(([testId, requirements]) => ({ testId, requirements })))
      return run
    } catch (error) {
      await run.stop()
      throw error
    }
  }

  /** Start an attempt with the same RPC allocation used by real runner fixtures. */
  startTest(id: Id, retry = 0) {
    const requirements = this.#plans.get(id)
    if (!requirements) throw new Error(`Unknown test: ${id}`)
    this.#coordinator.activate(id, retry)
    const allocation = this.#connections[0].open(id, requirements, retry)
    this.#disposal.defer(async () => {
      await allocation.release()
      allocation[Symbol.dispose]()
    })
    let deliveryPromise: Promise<Record<string, unknown>> | undefined
    const resources = () => deliveryPromise ??= (async () => {
      const delivery = await allocation.ready()
      this.#disposal.defer(() => delivery[Symbol.dispose]())
      return delivery.values
    })()
    return {
      resources,
      resource: async <C extends { kind: 'resource'; key: string } & ((alias: string, input: never) => ResourceRequest)>(
        contract: C, alias: string,
      ): Promise<ResourceValue<C>> => {
        if (requirements[alias]?.key !== contract.key)
          throw new Error(`Resource '${alias}' was not requested as '${contract.key}'`)
        return (await resources())[alias] as ResourceValue<C>
      },
      release: () => allocation.release(),
    }
  }

  /** Notify the scheduler of a finished attempt and its retry opportunity. */
  finishAttempt(id: Id, retry: number, status: 'passed' | 'failed' | 'skipped' | 'interrupted') {
    this.#coordinator.finish(id, status === 'skipped' ? undefined : retry)
    if (this.#prefetchRetries && status === 'failed' && retry < this.#retries) this.#coordinator.prefetchRetry(id, retry + 1)
  }

  service<C extends ReturnType<typeof service>>(contract: C): ServiceValue<C> {
    return this.#connections[0].getService(contract.key) as unknown as ServiceValue<C>
  }

  connect(): TestClient {
    const session = newWebSocketRpcSession<ProvisionEndpoint>(this.#server.url!)
    this.#connections.push(session)
    this.#disposal.defer(() => session[Symbol.dispose]())
    return new TestClient(session)
  }

  resolveService(contract: { kind: 'service'; key: string }): Promise<unknown> {
    return this.#services.resolve(contract as Parameters<ServiceRegistry['resolve']>[0])
  }

  closeServices(): Promise<void> {
    return this.#services.close()
  }

  async finishTests(): Promise<void> {
    if (this.#resourcesStopped) return
    this.#resourcesStopped = true
    await this.#coordinator.close()
  }

  stop(): Promise<void> {
    return this.#stopPromise ??= this.#disposal.disposeAsync()
  }
}

/** Every test owns all its allocations and RPC connections through a Vitest fixture. */
export const test = base.extend<{
  scenario: {
    log(event: string): void
    launch<const Plan extends RunPlan>(options: Plan): Promise<TestRun<TestIds<Plan>>>
  }
}>({
  scenario: async ({}, use) => {
    await using runs = new AsyncDisposableStack()
    const events: string[] = []
    await use({
      log: event => { events.push(event) },
      async launch<const Plan extends RunPlan>(options: Plan) {
        const run = await TestRun.start<TestIds<Plan>>(options, events)
        runs.defer(() => run.stop())
        return run
      },
    })
  },
})
