# @dlenroc/test-provision

Provision isolated test resources and shared services for Vitest and Playwright.
Tests declare resources before execution; providers create them, optionally
in advance, and the library runs registered cleanup afterward. Services
initialize on demand and are reused across tests. [Cap'n Web](https://capnweb.com/)
connects tests to both, including browser workers.

## Install

```sh
npm install --save-dev @dlenroc/test-provision
```

## Resource

Resources give tests isolated accounts without sharing their state. Inputs must
be JSON-serializable and are snapshotted using `JSON.parse(JSON.stringify(input))`.
The library relies on the input types and native JSON serialization behavior;
it performs no additional runtime validation. Don't include secrets, as
requirements can appear in test metadata.

```ts
// src/provision/resources/user.ts
import { resource } from "@dlenroc/test-provision";
import type { Account } from "../../app/accounts.js";

export const user = resource<{ name: string }, Account>("user");
```

## Service

Share one accounts client across tests instead of initializing one for every
resource. Services initialize on first use, and successful instances remain
until runner shutdown. Tests can access them with `prepared()` without `needs()`.

```ts
// src/provision/services/accounts.ts
import { service } from "@dlenroc/test-provision";
import type { AccountClient } from "../../app/accounts.js";

export const accounts = service<AccountClient>("accounts");
```

## Provider

The service provider initializes the client once; the resource provider uses it
to create isolated accounts. Each registers cleanup with `onCleanup()`.

```ts
// src/provision/services/providers/accounts.ts
import { provider } from "@dlenroc/test-provision";
import { createAccountClient } from "../../../app/accounts.js";
import { accounts } from "../accounts.js";

export const accountsProvider = provider(accounts, async ({ onCleanup }) => {
  const client = await createAccountClient();
  onCleanup(() => client.close());
  return client;
});
```

```ts
// src/provision/resources/providers/user.ts
import { provider } from "@dlenroc/test-provision";
import { accounts } from "../../services/accounts.js";
import { user } from "../user.js";

export const userProvider = provider(
  user,
  async ({ name }, { getService, onCleanup }) => {
    const client = await getService(accounts);
    const account = await client.createUser(name);
    onCleanup(() => client.deleteUser(account.id));
    return account;
  },
);
```

Resource providers can limit creation with `concurrency` or
`rateLimit: { limit, interval }` (`interval` in milliseconds).

## Test runners

Register both providers with `provision()`. Tests request isolated accounts with
`needs()` and access prepared resources and services with `prepared()`.

`withResources(base, { timeout })` can limit fixture setup and teardown in
milliseconds. The default `0` disables this limit; test timeouts are separate.

### Vitest

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { provision } from "@dlenroc/test-provision/vitest/plugin";
import { userProvider } from "./src/provision/resources/providers/user.js";
import { accountsProvider } from "./src/provision/services/providers/accounts.js";

export default defineConfig({
  plugins: [provision({ providers: [userProvider, accountsProvider] })],
});
```

```ts
// src/fixtures.ts
import { test as base, expect } from "vitest";
import { withResources, needs } from "@dlenroc/test-provision/vitest";

export const test = withResources(base);
export { expect, needs };
```

```ts
// tests/users.spec.ts
import { test, expect, needs } from "../src/fixtures.js";
import { user } from "../src/provision/resources/user.js";
import { accounts } from "../src/provision/services/accounts.js";

const alice = user("alice", { name: "Alice" });

test("creates a user", {
  meta: { provision: needs(alice) },
}, async ({ prepared }) => {
  const account = prepared(alice);
  expect(account.name).toBe("Alice");
  expect(await prepared(accounts).getUser(account.id)).toEqual(account);
});
```

### Playwright

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";
import { provision } from "@dlenroc/test-provision/playwright/reporter";
import { userProvider } from "./src/provision/resources/providers/user.js";
import { accountsProvider } from "./src/provision/services/providers/accounts.js";

export default defineConfig({
  reporter: [
    ["list"],
    provision({ providers: [userProvider, accountsProvider] }),
  ],
});
```

```ts
// src/fixtures.ts
import { test as base, expect } from "@playwright/test";
import { withResources, needs } from "@dlenroc/test-provision/playwright";

export const test = withResources(base);
export { expect, needs };
```

```ts
// tests/users.spec.ts
import { test, expect, needs } from "../src/fixtures.js";
import { user } from "../src/provision/resources/user.js";
import { accounts } from "../src/provision/services/accounts.js";

const alice = user("alice", { name: "Alice" });

test("creates a user", { annotation: needs(alice) }, async ({ prepared }) => {
  const account = prepared(alice);
  expect(account.name).toBe("Alice");
  expect(await prepared(accounts).getUser(account.id)).toEqual(account);
});
```

## Provision options

Resource concurrency is independent of test worker counts. Running tests take
priority over prefetching; services do not use these limits.

| Option                     | Default                            | Behavior                                                                     |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `concurrency.total`        | Unlimited                          | Maximum simultaneous resource creations                                      |
| `concurrency.prefetch`     | Up to 2, or `total - 1` if smaller | Maximum speculative creations; `0` disables prefetch                         |
| `prefetchRetries`          | `false`                            | Prepare resources ahead of retries                                           |
| `shutdownTimeout`          | 15 seconds                         | Maximum shutdown wait; unfinished cleanup is reported as a warning           |
| `precollect` (Vitest only) | `false`                            | Collect test modules in advance; may execute module-level side effects twice |
| `listenHost`               | `127.0.0.1`                        | Address on which the server listens                                          |
| `advertiseHost`            | `listenHost`                       | Host provided to workers and browsers                                        |

Connections use unencrypted `ws://`; expose them beyond loopback only on
trusted networks. Set a run-wide timeout in CI for providers that never finish.
