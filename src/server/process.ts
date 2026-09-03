import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";

type ProcessOutput = { stdout: string; stderr: string };

export function execFileWithInput(
  command: string,
  args: string[],
  input: string,
  options: ExecFileOptionsWithStringEncoding,
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error: ExecFileException | null, stdout: string, stderr: string) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin?.end(input);
  });
}
