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
      await docker(["rmi", "-f", BUILT_IMAGE]);
    } catch {}
  });

  it("build() builds an image from a Dockerfile", async () => {
    const result = await image.build(BUILT_IMAGE, tmpDir);
    assert.ok(typeof result.stderr === "string");
  });

  it("inspect() returns JSON metadata for the built image", async () => {
    const result = await image.inspect(BUILT_IMAGE);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed) && parsed.length > 0);
    assert.ok(
      parsed[0].RepoTags?.some((tag: string) => tag.startsWith(BUILT_IMAGE)),
    );
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

  it("inspect() returns JSON metadata", async () => {
    const result = await container.inspect(MAIN_CONTAINER);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed) && parsed.length > 0);
  });

  it("inspect() supports Go template formatting", async () => {
    const result = await container.inspect(MAIN_CONTAINER, "{{.State.Status}}");
    assert.equal(result.stdout.trim(), "running");
  });

  it("docker.exec() captures stdout from a command run inside the container", async () => {
    const result = await docker.exec(MAIN_CONTAINER, ["echo", "hello"]);
    assert.equal(result.stdout.trim(), "hello");
  });

  it("docker.exec() captures multi-word output", async () => {
    const result = await docker.exec(MAIN_CONTAINER, [
      "sh",
      "-c",
      "echo foo bar baz",
    ]);
    assert.equal(result.stdout.trim(), "foo bar baz");
  });

  it("run() passes environment variables into the container", async () => {
    const name = "suede-test-env";
    try {
      await container.run({
        image: "alpine:latest",
        name,
        command: ["sleep", "30"],
        env: { GREETING: "hello_env" },
      });
      const result = await docker.exec(name, ["sh", "-c", "echo $GREETING"]);
      assert.equal(result.stdout.trim(), "hello_env");
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
