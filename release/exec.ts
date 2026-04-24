import { execFile } from "child_process";
import { promisify } from "util";

export const execFileAsync = promisify(execFile);

export const runCmd = async (command: string, args: string[], cwd?: string) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout, stderr };
};

export type CmdResult = Awaited<ReturnType<typeof runCmd>>;
