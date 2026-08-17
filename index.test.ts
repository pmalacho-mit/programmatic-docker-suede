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
    const { stdout } = await docker([
      "version",
      "--format",
      "{{.Client.Version}}",
    ]);
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
    // build() returns a lazy CommandStream — drive it with .complete() to run
    // the build, then assert it exited cleanly.
    const result = await image.build(BUILT_IMAGE, tmpDir).complete();
    assert.equal(result.exit, 0, result.error?.message);
  });

  it("inspect() returns metadata for the built image", async () => {
    const info = await image.inspect(BUILT_IMAGE);
    assert.ok(
      info.RepoTags?.some((tag: string) => tag.startsWith(BUILT_IMAGE)),
    );
  });

  it("remove() deletes an image so subsequent inspect rejects", async () => {
    const tag = "suede-test-remove-img";
    await image.build(tag, tmpDir).complete();
    await image.remove(tag);
    await assert.rejects(() => image.inspect(tag));
  });
});

// Both builders report progress differently, and BuildKit — opted into with
// `version: "2"` — reports a failed step only inside its trace records. Run
// every case against both so a failed build is never mistaken for a good one.
describe("image.build across builders", () => {
  const versions = ["1", "2"] as const;
  const MARKER = "run-output-marker";
  /** What `MARKER` looks like if BuildKit's log output escapes undecoded. */
  const MARKER_BASE64 = Buffer.from(MARKER).toString("base64");

  let tmpDir: string;
  const tags: string[] = [];

  const build = async (tag: string, dockerfile: string, version: "1" | "2") => {
    await writeFile(join(tmpDir, "Dockerfile"), dockerfile);
    tags.push(tag);
    return image.build(tag, tmpDir, { version, nocache: true }).complete();
  };

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "suede-test-builders-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    for (const tag of tags) {
      try {
        await image.remove(tag);
      } catch {}
    }
  });

  for (const version of versions) {
    it(`builder ${version}: streams RUN output as readable text`, async () => {
      const result = await build(
        `suede-test-builder-${version}`,
        `FROM alpine:latest\nRUN echo ${MARKER}\n`,
        version,
      );
      assert.equal(result.exit, 0, result.error?.message);
      assert.match(result.out, new RegExp(MARKER));
      assert.doesNotMatch(result.out, new RegExp(MARKER_BASE64));
    });

    it(`builder ${version}: reports a failed build as a non-zero exit`, async () => {
      const result = await build(
        `suede-test-builder-fail-${version}`,
        `FROM alpine:latest\nRUN echo ${MARKER} && exit 7\n`,
        version,
      );
      assert.notEqual(result.exit, 0);
      assert.ok(result.error instanceof Error, "failure detail is missing");
      // The build log has to survive the failure, decoded, to be diagnosable.
      assert.match(result.out, new RegExp(MARKER));
      assert.doesNotMatch(result.out, new RegExp(MARKER_BASE64));
      assert.match(result.out, /ERROR/);
    });

    it(`builder ${version}: reports an unresolvable base image`, async () => {
      const result = await build(
        `suede-test-builder-base-${version}`,
        "FROM alpine:suede-test-no-such-tag\nRUN true\n",
        version,
      );
      assert.notEqual(result.exit, 0);
      assert.ok(result.error instanceof Error, "failure detail is missing");
    });
  }
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
