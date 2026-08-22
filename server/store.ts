import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import { config } from "./config.js";
const root = join(config.DATA_DIR, "objects");
function objectPath(key: string) {
  const destination = normalize(join(root, key));
  if (relative(root, destination).startsWith("..")) throw new Error("Invalid object key.");
  return destination;
}
export async function putJson(key: string, value: unknown) { const destination = objectPath(key); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, JSON.stringify(value), "utf8"); }
export async function putText(key: string, value: string) { const destination = objectPath(key); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, value, "utf8"); }
export async function getText(key: string) { return readFile(objectPath(key), "utf8"); }
