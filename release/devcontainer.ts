import { networkInterfaces } from "node:os";
import { container, type Container } from ".";
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

export const devcontainer = Object.assign(
  /**
   * Detect and return the current devcontainer by reading the hostname and resolving it to a container.
   * @returns The resolved devcontainer.
   */
  async () => {
    const { stdout } = await runCmd("hostname", []);
    const id = stdout.trim();

    if (/^[0-9a-f]{12,64}$/i.test(id))
      try {
        return container.resolve(id);
      } catch (e) {
        throw new Error(`Error resolving devcontainer id ${id}: ${String(e)}`);
      }

    throw new Error(
      "Could not detect devcontainer id from hostname; cannot use --network container:<id>",
    );
  },
  {
    /**
     * Detect and return the id of the current devcontainer by reading the hostname.
     * @throws If the hostname is not a valid container id or docker inspect fails.
     */
    id: () => devcontainer().then(({ id }) => id),
    /**
     * Return the NAME of the network the devcontainer is attached to, so sibling
     * containers can join it as ordinary peers (`--network <name>`) and reach
     * servers running inside the devcontainer via {@link devcontainer.ip}.
     *
     * If the devcontainer is attached to multiple networks, pass a `filter` to
     * pick one; without a `filter` in that case this throws.
     *
     * @param idOrConfig - Explicit container id/instance, or a config object
     * carrying that id plus an optional `filter` to choose among multiple
     * networks. Defaults to the auto-detected devcontainer.
     * @throws If the devcontainer has no network, or has multiple networks and
     * no `filter` was given.
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
     * Return the NAMES of every network the devcontainer is attached to.
     *
     * TypeScript equivalent of:
     * ```sh
     * docker inspect "$(hostname)" \
     *   --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'
     * ```
     * @param id - Explicit container id/instance. Defaults to the auto-detected devcontainer.
     */
    networks: async (id?: string): Promise<string[]> => {
      const { NetworkSettings } = await devcontainer.inspect(id);
      return Object.keys(NetworkSettings?.Networks ?? {});
    },

    inspect: async (instance?: Container.Instance) =>
      container.inspect(instance ?? (await devcontainer())),

    /**
     * Return the devcontainer's non-loopback IPv4 address.
     *
     * Use this as the bind/connect address when a sibling container joined to
     * the devcontainer's network (see {@link devcontainer.network}) needs to
     * reach a server running inside the devcontainer. That container reaches the
     * devcontainer over the shared network via this eth0 address, not loopback,
     * so a `127.0.0.1`-bound server won't see it — bind servers to `0.0.0.0`.
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
         * Return the devcontainer's IPv4 address as reported by `docker inspect`,
         * read from `NetworkSettings.Networks[<name>].IPAddress`.
         *
         * Unlike {@link devcontainer.ip} (which reads `node:os` interfaces and so
         * only works *inside* the devcontainer), this works from the host or a
         * sibling container. It returns the address on the network that
         * {@link devcontainer.network} selects, so a sibling joined via
         * `--network <name>` reaches the devcontainer at this address.
         *
         * TypeScript equivalent of:
         * ```sh
         * docker inspect "$(hostname)" \
         *   --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{"\n"}}{{end}}'
         * ```
         * @param idOrConfig - Explicit container id/instance, or a config object
         * carrying that id plus an optional `filter` (forwarded to
         * {@link devcontainer.network}) to choose among multiple networks.
         * Defaults to the auto-detected devcontainer.
         * @throws If no address can be determined from `docker inspect`.
         */
        inspect: async (
          idOrConfig?: IdOrConfig<{ filter?: (networks: string[]) => string }>,
        ): Promise<string> => {
          const id = tryResolve(idOrConfig);
          const { NetworkSettings } = await devcontainer.inspect(id);
          const networks = NetworkSettings?.Networks ?? {};
          const name = await devcontainer.network(idOrConfig);
          const ip = name ? networks[name]?.IPAddress : undefined;
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
