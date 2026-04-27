import { networkInterfaces } from "node:os";
import { container } from ".";
import { runCmd } from "./exec.js";

export const getDevcontainer = async () => {
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
};

/**
 * Detect and return the id of the current devcontainer by reading the hostname.
 * @throws If the hostname is not a valid container id or docker inspect fails.
 */
export const getDevcontainerId = () => getDevcontainer().then(({ id }) => id);

/**
 * Return a `container:<id>` network string for use with `--network` when running containers alongside the devcontainer.
 * @param devcontainerId - Explicit container id. Defaults to the auto-detected devcontainer id.
 */
export const devcontainerNetwork = async (devcontainerId?: string) =>
  `container:${devcontainerId ?? (await getDevcontainerId())}` as const;

/**
 * Return the devcontainer's non-loopback IPv4 address.
 *
 * Use this as the bind/connect address when a container joined via
 * `--network container:<id>` needs to reach a server running inside the
 * devcontainer. Connections from that container travel through the shared
 * eth0 interface, not loopback, so a `127.0.0.1`-bound server won't see them.
 * @throws If no non-loopback IPv4 interface is found.
 */
export const getDevcontainerIp = (): string => {
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.family === "IPv4")?.address;
  if (ip) return ip;
  throw new Error("Could not determine devcontainer IP address");
};
