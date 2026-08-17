# programmatic-docker-suede

Thin TypeScript wrappers around [Dockerode](https://github.com/apocas/dockerode) for building images, running containers, and streaming command output. Read the source — it's short.

## Exports

**[index.ts](index.ts)** — main entry point

- `docker(args, cwd?)` — raw `docker` CLI escape hatch. Also exposes `docker.verify()` (pings the daemon), `docker.createNetwork(name)` / `docker.tryCreateNetwork(name)`, and `docker.removeNetwork(name)` / `docker.tryRemoveNetwork(name)` (the `try*` variants swallow errors)
- `image` — `build(tag, context, options?)`, `inspect(name)`, `pull(name)`, `remove(name, force?)`. `build` options extend Dockerode's `ImageBuildOptions` plus `include?: string[]` to restrict the build context. `build` returns a `CommandStream`; a failed build resolves with a non-zero `exit` and an `error` — for the classic builder *and* for BuildKit (`version: "2"`)
- `container` — `run(opts)`, `exec(c, args)`, `log(c)`, `inspect(c)`, `isRunning(c)`, `start(c)`, `resolve(c)`, `remove(c, force?)`, `tryRemove(c, force?)`
- `dockerode` — underlying Dockerode instance for advanced use
- `Container` namespace — `RunOptions`, `Instance`, `PublishedPort`, `MountedVolume` types

**[CommandStream.ts](CommandStream.ts)** — returned by `image.build()`, `container.exec()` and `container.log()`

- `.complete()` — buffers all output; returns `{ out, err, exit, error? }`. Never throws — failures come back as a non-zero `exit` with an `error`.
- `.chunks()` — async generator yielding `{ kind: "out"|"err", data }` as they arrive; call `.complete()` after to get the exit code

Both methods accept an optional encoding arg (`"string"` | `"buffer"` | `{ out?, err? }`).

**[progress.ts](progress.ts)** — reader for Docker's JSON progress streams, used by `image.build()` and `image.pull()`

- `followProgress(stream, onText)` — forwards human-readable output and resolves with the daemon's `Failure` (or `undefined`). Decodes BuildKit's `moby.buildkit.trace` records — base64-encoded protobuf that `dockerode.followProgress` passes through undecoded — into `--progress=plain`-style lines, and reports failed steps, which BuildKit only reports inside those records.

**[devcontainer.ts](devcontainer.ts)** — devcontainer networking utilities

Default export `devcontainer` is a callable object: calling it detects the current devcontainer (by hostname) and resolves it to a Dockerode `Container`. Its methods let a sibling container join the devcontainer's network as a peer (`--network <name>`) and reach servers inside it.

- `devcontainer()` — detects the current devcontainer from hostname and returns its Dockerode `Container` handle
- `devcontainer.id()` — resolves to the current devcontainer's container id
- `devcontainer.network(idOrConfig?)` — resolves to the NAME of the network the devcontainer is attached to, for use as `network` in `container.run()`. If attached to multiple networks, pass `{ id, filter }` to choose one (throws otherwise). Defaults to the auto-detected devcontainer
- `devcontainer.networks(id?)` — resolves to the NAMES of every network the devcontainer is attached to
- `devcontainer.inspect(instance?)` — `docker inspect` for the devcontainer (or a given instance)
- `devcontainer.ip()` — the devcontainer's non-loopback IPv4 from local `node:os` interfaces (only works *inside* the devcontainer). Servers bound to `127.0.0.1` aren't reachable from a peer container, so bind to `0.0.0.0`
- `devcontainer.ip.inspect(idOrConfig?)` — the devcontainer's IPv4 as reported by `docker inspect` (works from the host or a sibling container); reads the address on the network `devcontainer.network` selects
