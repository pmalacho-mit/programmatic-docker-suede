import { runCmd } from "./exec.js";

export const docker = Object.assign(
  async (args: string[], cwd?: string) => runCmd("docker", args, cwd),
  {
    exec: async (container: string, args: string[]) =>
      docker(["exec", container, ...args]),
    verify: async () => {
      try {
        await docker(["info"]);
        return true;
      } catch {
        return false;
      }
    },
  },
);

export const image = {
  inspect: async (name: string) => docker(["image", "inspect", name]),
  build: async (tag: string, context: string) =>
    docker(["build", "-t", tag, "."], context),
};

namespace Container {
  /** Environment variables to pass to a container. Object with string keys and string values. Example: `{ DATABASE_URL: "postgres://...", DEBUG: "true" }` */
  type Env = Record<string, string>;

  export type PublishedPort = {
    /** The port or interface:port on the host machine. Example: "8080" or "127.0.0.1:8080" */
    host: string | number;
    /** The port exposed by the container. Example: "3000" */
    container: string | number;
  };

  export type MountedVolume = {
    /** The host path to mount. Example: "/host/data" */
    source: string;
    /** The container path to mount to. Example: "/app/data" */
    target: string;
    /** Whether the volume should be read-only. Default: false (writable) */
    readOnly?: boolean;
  };

  export type RunOptions = {
    /** Docker image to run (required). Example: "node:20", "browser-control" */
    image: string;
    /** Command and arguments to execute in the container. Default: none */
    command?: string[];
    /** Container name for identification. Default: Docker auto-generated name */
    name?: string;
    /** Network to connect the container to. Default: default bridge network */
    network?: string;
    /** Environment variables to set in the container. Default: none */
    env?: Env;
    /** Ports to publish from container to host. Default: none */
    ports?: PublishedPort[];
    /** Volumes to mount into the container. Default: none */
    volumes?: MountedVolume[];
    /** Additional docker run arguments (e.g., ["--cap-add", "SYS_ADMIN"]). Default: none */
    extraArgs?: string[];
    /** Working directory for executing the docker command. Default: process.cwd() */
    cwd?: string;
    /** Run container in detached mode (background). Default: true */
    detached?: boolean;
    /** Automatically remove container when it stops. Default: true */
    removeOnStop?: boolean;
  };
}

export const container = {
  args: {
    format: <T extends string>(format: T) => ["-f", format] as const,
    name: <T extends string>(name: T) => ["--name", name] as const,
    network: <T extends string>(network: T) => ["--network", network] as const,
    removeOnStop: "--rm",
    detached: "-d",
    env: (key: string, value: string) => ["-e", `${key}=${value}`] as const,
    ports: ({ host, container }: Container.PublishedPort) =>
      ["-p", `${host}:${container}`] as const,
    volumes: ({ source, target, readOnly }: Container.MountedVolume) =>
      ["-v", `${source}:${target}${readOnly ? ":ro" : ""}`] as const,
  } as const,

  /**
   * Inspect a container
   * @param name - The container name or id.
   * @param formatting - Go template used by docker --format.
   */
  inspect: async (name: string, formatting?: string) =>
    docker([
      "container",
      "inspect",
      ...(formatting ? ["-f", formatting] : []),
      name,
    ]),
  /**
   * Check whether a container is currently running.
   * @param name - The container name or id.
   */
  isRunning: async (name: string) => {
    const result = await container.inspect(name, "{{.State.Running}}");
    return result.stdout.trim() === "true";
  },
  /**
   * Start an existing container.
   * @param name - The container name or id.
   */
  start: async (name: string) => docker(["start", name]),

  run: async ({
    image,
    command,
    name,
    network,
    env,
    ports,
    volumes,
    extraArgs,
    cwd,
    detached = true,
    removeOnStop = true,
  }: Container.RunOptions) => {
    const dockerArgs = ["run"];

    if (detached) dockerArgs.push(container.args.detached);
    if (removeOnStop) dockerArgs.push(container.args.removeOnStop);

    if (name) dockerArgs.push(...container.args.name(name));
    if (network) dockerArgs.push(...container.args.network(network));

    if (env)
      for (const [key, value] of Object.entries(env))
        dockerArgs.push(...container.args.env(key, value));

    if (ports)
      for (const port of ports) dockerArgs.push(...container.args.ports(port));

    if (volumes)
      for (const volume of volumes)
        dockerArgs.push(...container.args.volumes(volume));

    if (extraArgs) dockerArgs.push(...extraArgs);

    dockerArgs.push(image);
    if (command?.length) dockerArgs.push(...command);

    return docker(dockerArgs, cwd);
  },
  /**
   * Remove a container.
   * @param name - The name of the container to remove.
   * @param force - Force removal without stopping. Default: true
   */
  remove: async (name: string, force = true) =>
    docker(["rm", ...(force ? ["-f"] : []), name]),
};
