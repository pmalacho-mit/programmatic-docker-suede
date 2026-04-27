import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, image, container } from "./release";

const BUILT_IMAGE = "suede-test-image";
const MAIN_CONTAINER = "suede-test-main";

describe("docker", () => {
  it("verify() returns true when Docker daemon is reachable", async () => {
    assert.equal(await docker.verify(), true);
  });

  it("docker() runs a raw CLI command and returns stdout", async () => {
    const { stdout } = await docker(["version", "--format", "{{.Client.Version}}"]);
    assert.match(stdout.trim(), /^\d+\.\d+/);
  });
});

describe("image", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "suede-test-"));
    await writeFile(join(tmpDir, "Dockerfile"), "FROM alpine:latest\n");
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    try {
      await image.remove(BUILT_IMAGE);
    } catch {}
  });

  it("build() builds an image from a Dockerfile", async () => {
    // build() resolves void on success, rejects on failure
    await image.build(BUILT_IMAGE, tmpDir);
  });

  it("inspect() returns metadata for the built image", async () => {
    const info = await image.inspect(BUILT_IMAGE);
    assert.ok(
      info.RepoTags?.some((tag: string) => tag.startsWith(BUILT_IMAGE)),
    );
  });

  it("remove() deletes an image so subsequent inspect rejects", async () => {
    const tag = "suede-test-remove-img";
    await image.build(tag, tmpDir);
    await image.remove(tag);
    await assert.rejects(() => image.inspect(tag));
  });
});

describe("container", () => {
  before(async () => {
    try {
      await container.remove(MAIN_CONTAINER);
    } catch {}
    await container.run({
      image: "alpine:latest",
      name: MAIN_CONTAINER,
      command: ["sleep", "120"],
    });
  });

  after(async () => {
    try {
      await container.remove(MAIN_CONTAINER);
    } catch {}
  });

  it("isRunning() returns true for a running container", async () => {
    assert.equal(await container.isRunning(MAIN_CONTAINER), true);
  });

  it("isRunning() returns false for a non-existent container", async () => {
    assert.equal(await container.isRunning("suede-test-ghost"), false);
  });

  it("inspect() returns container metadata", async () => {
    const info = await container.inspect(MAIN_CONTAINER);
    assert.equal(info.State.Running, true);
    assert.equal(info.State.Status, "running");
  });

  it("docker.exec() captures stdout from a command run inside the container", async () => {
    const { out } = await container
      .exec(MAIN_CONTAINER, ["echo", "hello"])
      .complete();
    assert.equal(out.trim(), "hello");
  });

  it("docker.exec() captures multi-word output", async () => {
    const { out } = await container
      .exec(MAIN_CONTAINER, ["sh", "-c", "echo foo bar baz"])
      .complete();
    assert.equal(out.trim(), "foo bar baz");
  });

  it("exec() captures stderr", async () => {
    const { err } = await container
      .exec(MAIN_CONTAINER, ["sh", "-c", "echo err-output >&2"])
      .complete();
    assert.equal(err.trim(), "err-output");
  });

  it("exec() reports non-zero exit codes", async () => {
    const result = await container
      .exec(MAIN_CONTAINER, ["sh", "-c", "exit 42"])
      .complete();
    assert.equal(result.exit, 42);
  });

  it('exec() complete("buffer") returns Buffer instances', async () => {
    const { out } = await container
      .exec(MAIN_CONTAINER, ["echo", "buftest"])
      .complete("buffer");
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.toString().trim(), "buftest");
  });

  it("exec().chunks() streams output incrementally", async () => {
    const stream = container.exec(MAIN_CONTAINER, [
      "sh",
      "-c",
      "echo chunk-test",
    ]);
    const parts: string[] = [];
    for await (const chunk of stream.chunks()) {
      if (chunk.kind === "out") parts.push(chunk.data);
    }
    assert.equal(parts.join("").trim(), "chunk-test");
  });

  it("log() captures stdout from a short-lived container", async () => {
    const c = await container.run({
      image: "alpine:latest",
      command: ["sh", "-c", "echo hello-log"],
      removeOnStop: false,
    });
    const { out } = await container.log(c).complete();
    await container.remove(c);
    assert.equal(out.trim(), "hello-log");
  });

  it("run() mounts volumes into the container", async () => {
    const name = "suede-test-vol";
    try {
      const c = await container.run({
        image: "alpine:latest",
        name,
        command: ["sleep", "30"],
        volumes: [{ source: "/tmp", target: "/mnt/host-tmp" }],
      });
      const result = await container
        .exec(c, ["ls", "/mnt/host-tmp"])
        .complete();
      assert.equal(result.exit, 0);
    } finally {
      try {
        await container.remove(name);
      } catch {}
    }
  });

  it("start() restarts a stopped container", async () => {
    const name = "suede-test-start";
    try {
      await container.run({
        image: "alpine:latest",
        name,
        command: ["sleep", "60"],
        removeOnStop: false,
      });
      await container.resolve(name).stop();
      assert.equal(await container.isRunning(name), false);
      await container.start(name);
      assert.equal(await container.isRunning(name), true);
    } finally {
      try {
        await container.remove(name);
      } catch {}
    }
  });

  it("run() passes environment variables into the container", async () => {
    const name = "suede-test-env";
    try {
      const instance = await container.run({
        image: "alpine:latest",
        name,
        command: ["sleep", "30"],
        env: { GREETING: "hello_env" },
      });
      const { out } = await container
        .exec(instance, ["sh", "-c", "echo $GREETING"])
        .complete();
      assert.equal(out.trim(), "hello_env");
    } finally {
      try {
        await container.remove(name);
      } catch {}
    }
  });

  it("remove() force-removes a running container so subsequent inspect rejects", async () => {
    const name = "suede-test-rm";
    await container.run({
      image: "alpine:latest",
      name,
      command: ["sleep", "30"],
    });
    await container.remove(name);
    await assert.rejects(() => container.inspect(name));
  });
});
