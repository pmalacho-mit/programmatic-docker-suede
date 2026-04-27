import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  getDevcontainerId,
  getDevcontainerIp,
  devcontainerNetwork,
} from "./release/devcontainer.js";
import { container } from "./release";

describe(getDevcontainerId.name, () => {
  it("should return a valid devcontainer ID", async () => {
    const id = await getDevcontainerId();
    console.log("Detected devcontainer ID:", id);
    assert.match(id, /^[0-9a-f]{12,64}$/i, "devcontainer ID not alphanumeric");
  });
});

describe(getDevcontainerIp.name, () => {
  it("returns a non-loopback IPv4 address", () => {
    const ip = getDevcontainerIp();
    assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.notEqual(ip, "127.0.0.1");
  });
});

describe(devcontainerNetwork.name, () => {
  it("returns a network string in the form container:<id>", async () => {
    const network = await devcontainerNetwork();
    assert.match(network, /^container:[0-9a-f]{12,64}$/i);
  });

  it("accepts an explicit devcontainer ID", async () => {
    const id = await getDevcontainerId();
    const network = await devcontainerNetwork(id);
    assert.equal(network, `container:${id}`);
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
      const c = await container.run({
        image: "alpine:latest",
        command: [
          "wget",
          "-q",
          "-O",
          "-",
          `http://${getDevcontainerIp()}:${port}`,
        ],
        network: await devcontainerNetwork(),
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
