import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { devcontainer } from "./release/devcontainer.js";
import { container, image } from "./release";

describe("devcontainer.id", () => {
  it("should return a valid devcontainer ID", async () => {
    const id = await devcontainer.id();
    console.log("Detected devcontainer ID:", id);
    assert.match(id, /^[0-9a-f]{12,64}$/i, "devcontainer ID not alphanumeric");
  });
});

describe("devcontainer.ip", () => {
  it("returns a non-loopback IPv4 address", () => {
    const ip = devcontainer.ip();
    assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.notEqual(ip, "127.0.0.1");
  });
});

describe("devcontainer.network", () => {
  it("returns a non-gate network name", async () => {
    const network = await devcontainer.network();
    assert.equal(typeof network, "string");
    assert.ok(network.length > 0, "network name is empty");
    assert.doesNotMatch(
      network,
      /(^|[-_])gate$/,
      "should not be the gate network",
    );
  });

  it("accepts an explicit devcontainer ID", async () => {
    const id = await devcontainer.id();
    const network = await devcontainer.network(id);
    assert.equal(network, await devcontainer.network());
  });

  it("a container on the devcontainer network can reach a server running inside the devcontainer", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("pong");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    const { port } = server.address() as AddressInfo;

    try {
      // container.run creates via the Engine API, which does not auto-pull a
      // missing image — ensure it's present first (e.g. on a fresh daemon).
      await image.pull("alpine:latest");
      const c = await container.run({
        image: "alpine:latest",
        command: [
          "wget",
          "-q",
          "-O",
          "-",
          `http://${devcontainer.ip()}:${port}`,
        ],
        network: await devcontainer.network(),
        removeOnStop: false,
      });

      const { out } = await container.log(c).complete();
      await container.remove(c);
      assert.equal(out.trim(), "pong");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
