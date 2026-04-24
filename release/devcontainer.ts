import { docker } from "./docker";
import { runCmd } from "./exec";

export const inspectDevcontainer = async (id: string) =>
  docker(["inspect", id]);

export const getDevcontainerId = async (): Promise<string> => {
  const { stdout } = await runCmd("hostname", []);
  const id = stdout.trim();

  if (/^[0-9a-f]{12,64}$/i.test(id)) {
    const { stderr } = await inspectDevcontainer(id);
    if (stderr.trim())
      throw new Error(`Error inspecting devcontainer id ${id}: ${stderr}`);
    return id;
  }

  throw new Error(
    "Could not detect devcontainer id from hostname; cannot use --network container:<id>",
  );
};

export const devcontainerNetwork = async (devcontainerId?: string) =>
  `container:${devcontainerId ?? (await getDevcontainerId())}` as const;
