import { networkInterfaces } from "node:os";
import { container, dockerode, type Container } from ".";
import { runCmd } from "./exec.js";

/** A container reference: either a bare id string, or a config object carrying that id plus extra options `T`. */
type IdOrConfig<T extends {} = {}> = string | ({ id: string } & T);

/** Narrow an {@link IdOrConfig} down to its bare id string, or `undefined` when no reference was given. */
const tryResolve = (idOrConfig?: IdOrConfig<{}>) =>
  idOrConfig
    ? typeof idOrConfig === "string"
      ? idOrConfig
      : idOrConfig?.id
    : undefined;

/**
 * How the Docker daemon this process talks to relates to the devcontainer.
 *
 * - `"peer"` — **docker-outside-of-docker**. The daemon also runs the
 *   devcontainer, so the devcontainer and the containers it creates are
 *   siblings, and the devcontainer appears in that daemon's container list.
 * - `"host"` — **docker-in-docker**. The daemon runs *inside* the
 *   devcontainer, so the devcontainer is not one of its containers at all —
 *   it is the host that every one of the daemon's bridge networks is
 *   attached to.
 *
 * The distinction matters because "reach the devcontainer from a sibling"
 * is answered differently in each: under `"peer"` the devcontainer is a node
 * *on* the network, under `"host"` it sits at the network's gateway.
 */
export type Topology = "peer" | "host";

/**
 * Read the hostname and require it to look like a container id.
 * @throws If the hostname is not a valid container id.
 */
const hostnameId = async () => {
  const { stdout } = await runCmd("hostname", []);
  const id = stdout.trim();
  if (/^[0-9a-f]{12,64}$/i.test(id)) return id;
  throw new Error(
    `Could not detect devcontainer id from hostname (got ${JSON.stringify(id)})`,
  );
};

/** Names of every bridge-driver network owned by the daemon we're talking to. */
const bridgeNetworks = async () =>
  (await dockerode.listNetworks())
    .filter(({ Driver }) => Driver === "bridge")
    .map(({ Name }) => Name);

/** Memoized: the topology never changes for the lifetime of the process. */
let topology: Promise<Topology> | undefined;

const notAContainerOfThisDaemon = (what: string) =>
  new Error(
    `Cannot ${what}: this Docker daemon runs inside the devcontainer ` +
      `(docker-in-docker), so the devcontainer is not one of its containers. ` +
      `Use devcontainer.network() / devcontainer.ip() instead — they work ` +
      `under both topologies.`,
  );

export const devcontainer = Object.assign(
  /**
   * Detect and return the current devcontainer by reading the hostname and resolving it to a container.
   *
   * Only meaningful under the `"peer"` {@link Topology}; under `"host"` the
   * devcontainer is not a container of this daemon, and the returned handle
   * will 404 on use.
   * @returns The resolved devcontainer.
   */
  async () => {
    const id = await hostnameId();
    try {
      return container.resolve(id);
    } catch (e) {
      throw new Error(`Error resolving devcontainer id ${id}: ${String(e)}`);
    }
  },
  {
    /**
     * Determine how the Docker daemon relates to the devcontainer — see
     * {@link Topology}.
     *
     * Probes the capability directly rather than guessing from the
     * environment: if the daemon can inspect the container this process is
     * running in, it is a `"peer"`; if it cannot, the daemon is running
     * inside us and we are its `"host"`.
     *
     * The result is memoized for the lifetime of the process.
     */
    topology: (): Promise<Topology> =>
      (topology ??= (async () => {
        try {
          await container.resolve(await hostnameId()).inspect();
          return "peer" as const;
        } catch {
          return "host" as const;
        }
      })()),
    /**
     * Detect and return the id of the current devcontainer by reading the hostname.
     * @throws If the hostname is not a valid container id.
     */
    id: () => hostnameId(),
    /**
     * Return the NAME of the network a sibling container should join
     * (`--network <name>`) in order to reach servers running inside the
     * devcontainer at {@link devcontainer.ip}.
     *
     * If more than one network qualifies, pass a `filter` to pick one;
     * without a `filter` in that case this throws.
     *
     * @param idOrConfig - Explicit container id/instance, or a config object
     * carrying that id plus an optional `filter` to choose among multiple
     * networks. Defaults to the auto-detected devcontainer. The id is ignored
     * under the `"host"` {@link Topology}.
     * @throws If no network qualifies, or several do and no `filter` was given.
     */
    network: async (
      idOrConfig?: IdOrConfig<{ filter?: (networks: string[]) => string }>,
    ) => {
      const networks = await devcontainer.networks(tryResolve(idOrConfig));
      if (networks.length === 1) return networks[0];
      if (networks.length === 0)
        throw new Error("Could not determine the devcontainer's network");
      if (!idOrConfig || typeof idOrConfig === "string" || !idOrConfig.filter)
        throw new Error(
          "Multiple networks found, and no `filter` was provided to select one.",
        );
      return idOrConfig.filter(networks);
    },

    /**
     * Return the NAMES of every network on which a sibling container can reach
     * the devcontainer.
     *
     * How that is computed depends on the {@link Topology}:
     *
     * - `"peer"` — the networks the devcontainer is itself attached to.
     *   TypeScript equivalent of:
     *   ```sh
     *   docker inspect "$(hostname)" \
     *     --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'
     *   ```
     * - `"host"` — every bridge network the daemon owns. The devcontainer is
     *   not *on* any of them, but it hosts all of them, so a container on any
     *   one reaches it via that network's gateway.
     *
     * @param id - Explicit container id/instance. Defaults to the
     * auto-detected devcontainer. Ignored under the `"host"` topology, where
     * the devcontainer is not a container of this daemon.
     */
    networks: async (id?: string): Promise<string[]> =>
      (await devcontainer.topology()) === "host"
        ? bridgeNetworks()
        : Object.keys(
            (await devcontainer.inspect(id)).NetworkSettings?.Networks ?? {},
          ),

    /**
     * Inspect the devcontainer as a container of this daemon.
     * @throws Under the `"host"` {@link Topology}, where it is not one.
     */
    inspect: async (instance?: Container.Instance) => {
      if (!instance && (await devcontainer.topology()) === "host")
        throw notAContainerOfThisDaemon("inspect the devcontainer");
      return container.inspect(instance ?? (await devcontainer()));
    },

    /**
     * Return the devcontainer's non-loopback IPv4 address.
     *
     * Use this as the bind/connect address when a sibling container joined to
     * the devcontainer's network (see {@link devcontainer.network}) needs to
     * reach a server running inside the devcontainer. That container reaches the
     * devcontainer over the shared network via this eth0 address, not loopback,
     * so a `127.0.0.1`-bound server won't see it — bind servers to `0.0.0.0`.
     *
     * Works under both topologies: under `"host"` the sibling's traffic is
     * routed to the devcontainer by the bridge it sits behind.
     * @throws If no non-loopback IPv4 interface is found.
     */
    ip: Object.assign(
      (): string => {
        const ip = Object.values(networkInterfaces())
          .flat()
          .find((i) => i && !i.internal && i.family === "IPv4")?.address;
        if (ip) return ip;
        throw new Error("Could not determine devcontainer IP address");
      },
      {
        /**
         * Return the address at which a container on the network selected by
         * {@link devcontainer.network} reaches the devcontainer, as reported by
         * the daemon.
         *
         * Unlike {@link devcontainer.ip} (which reads `node:os` interfaces and so
         * only works *inside* the devcontainer), this works from the host or a
         * sibling container.
         *
         * Which address that is depends on the {@link Topology}:
         *
         * - `"peer"` — the devcontainer's own address on that network, read from
         *   `NetworkSettings.Networks[<name>].IPAddress`:
         *   ```sh
         *   docker inspect "$(hostname)" \
         *     --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{"\n"}}{{end}}'
         *   ```
         * - `"host"` — that network's gateway, which *is* the devcontainer:
         *   ```sh
         *   docker network inspect <name> --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
         *   ```
         *
         * @param idOrConfig - Explicit container id/instance, or a config object
         * carrying that id plus an optional `filter` (forwarded to
         * {@link devcontainer.network}) to choose among multiple networks.
         * Defaults to the auto-detected devcontainer.
         * @throws If no address can be determined.
         */
        inspect: async (
          idOrConfig?: IdOrConfig<{ filter?: (networks: string[]) => string }>,
        ): Promise<string> => {
          const name = await devcontainer.network(idOrConfig);

          if ((await devcontainer.topology()) === "host") {
            const { IPAM } = await dockerode.getNetwork(name).inspect();
            const gateway = IPAM?.Config?.find(
              (c: { Gateway?: string }) => c.Gateway,
            )?.Gateway;
            if (gateway) return gateway;
            throw new Error(
              `Could not determine the devcontainer's gateway address on network ${name}`,
            );
          }

          const { NetworkSettings } = await devcontainer.inspect(
            tryResolve(idOrConfig),
          );
          const ip = NetworkSettings?.Networks?.[name]?.IPAddress;
          if (ip) return ip;
          throw new Error(
            "Could not determine devcontainer IP address from docker inspect",
          );
        },
      },
    ),
  },
);

export default devcontainer;
