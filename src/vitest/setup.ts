import { aroundEach, inject, TestRunner, type TestAPI } from "vitest";
import { collectRequirements } from "../core/contract.js";
import { getSession } from "../core/session.js";

type Around = Parameters<TestAPI<{ prepared?: unknown }>["aroundEach"]>[0];

// Setup files execute for every module, including when imported fixtures are cached.
// Capture only our synchronous hook registration so unrelated tests retain Vitest's
// normal automatic-fixture timing. Preserve the native hook's timeout metadata.
const collector = TestRunner.getCurrentSuite();
const register = collector.on;
collector.on = (name, ...callbacks) => {
  if (name === "aroundEach") {
    const native = callbacks[0] as unknown as Around;
    const gated: Around = async (runTest, context, suite) => {
      if (!context.task.meta.provision?.length) return runTest();
      // Ready telemetry can describe a skipped task. Workers announce current
      // requirements while other automatic fixtures initialize independently.
      const activation = getSession(inject("__test_provision_rpc_url__"))
        .activate(context.task.id, collectRequirements(context.task.meta.provision))
        .catch(() => {});
      try {
        return await native(runTest, context, suite);
      }
      // A fixture may skip before prepared opens; finish telemetry must not
      // overtake its activation on the separate RPC connection.
      finally {
        await activation;
      }
    };
    register(name, ...([Object.assign(gated, native)] as typeof callbacks));
  } else register(name, ...callbacks);
};
try {
  aroundEach<{ prepared?: unknown }>(async (runTest, { prepared }) => {
    void prepared;
    await runTest();
  }, 0);
} finally {
  collector.on = register;
}
