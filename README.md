# programmatic-docker-suede

Thin TypeScript wrappers around [Dockerode](https://github.com/apocas/dockerode) for building images, running containers, and streaming command output. Read the source — it's short.

## Exports

**[index.ts](index.ts)** — main entry point

- `docker(args, cwd?)` — raw `docker` CLI escape hatch. Also exposes `docker.verify()` (pings the daemon), `docker.createNetwork(name)` / `docker.tryCreateNetwork(name)`, and `docker.removeNetwork(name)` / `docker.tryRemoveNetwork(name)` (the `try*` variants swallow errors)
- `image` — `build(tag, context, options?)`, `inspect(name)`, `remove(name, force?)`. `build` options extend Dockerode's `ImageBuildOptions` plus `include?: string[]` to restrict the build context
- `container` — `run(opts)`, `exec(c, args)`, `log(c)`, `inspect(c)`, `isRunning(c)`, `start(c)`, `resolve(c)`, `remove(c, force?)`, `tryRemove(c, force?)`
- `dockerode` — underlying Dockerode instance for advanced use
- `Container` namespace — `RunOptions`, `Instance`, `PublishedPort`, `MountedVolume` types

**[CommandStream.ts](CommandStream.ts)** — returned by `container.exec()` and `container.log()`

- `.complete()` — buffers all output; returns `{ out, err, exit }`. Never throws.
- `.chunks()` — async generator yielding `{ kind: "out"|"err", data }` as they arrive; call `.complete()` after to get the exit code

Both methods accept an optional encoding arg (`"string"` | `"buffer"` | `{ out?, err? }`).

**[devcontainer.ts](devcontainer.ts)** — devcontainer networking utilities

- `getDevcontainer()` — detects the current devcontainer from hostname and returns its Dockerode `Container` handle
- `getDevcontainerId()` — detects the current devcontainer's container ID from hostname
- `getDevcontainerIp()` — returns the devcontainer's non-loopback IPv4 (needed because `127.0.0.1`-bound servers aren't reachable from a joined container)
- `devcontainerNetwork(id?)` — async; returns `"container:<id>"` for use as `network` in `container.run()` (defaults to the auto-detected devcontainer id)
