import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { devcontainer } from "./release/devcontainer.js";
import { container, image } from "./release";

/**
 * Stand up a throwaway server inside the devcontainer, then ask a sibling
 * container joined to `devcontainer.network()` to fetch it at `address`.
 * Resolves to what the sibling actually received.
 */
const fetchedBySibling = async (address: () => string | Promise<string>) => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("pong");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const tag = "alpine:latest";

  try {
    await image.inspect(tag).catch(() => image.pull(tag));
    const c = await container.run({
      image: tag,
      command: ["wget", "-q", "-O", "-", `http://${await address()}:${port}`],
      network: await devcontainer.network(),
      removeOnStop: false,
    });

    const { out } = await container.log(c).complete();
    await container.remove(c);
    return out.trim();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("devcontainer.topology", () => {
  it("reports a known topology, and reports it consistently", async () => {
    const topology = await devcontainer.topology();
    console.log("Detected topology:", topology);
    assert.ok(
      topology === "peer" || topology === "host",
      `unexpected topology ${topology}`,
    );
    assert.equal(await devcontainer.topology(), topology);
  });
});

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
    assert.equal(await fetchedBySibling(() => devcontainer.ip()), "pong");
  });
});

describe("devcontainer.ip.inspect", () => {
  it("returns an IPv4 address", async () => {
    assert.match(await devcontainer.ip.inspect(), /^\d{1,3}(\.\d{1,3}){3}$/);
  });

  // The address differs by topology — the devcontainer's own address on the
  // network under "peer", that network's gateway under "host" — but it must
  // reach the devcontainer either way. This is what regressed when the daemon
  // moved from docker-outside-of-docker to docker-in-docker.
  it("returns an address a sibling on that network can reach the devcontainer at", async () => {
    assert.equal(
      await fetchedBySibling(() => devcontainer.ip.inspect()),
      "pong",
    );
  });
});
