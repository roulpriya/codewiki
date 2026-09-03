import { rm } from "node:fs/promises";
import { relative } from "node:path";

const root = import.meta.dir + "/..";
const output = `${root}/dist/web`;

await rm(output, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [`${root}/src/client.tsx`],
  outdir: output,
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for await (const file of new Bun.Glob("**/*").scan({ cwd: `${root}/public`, onlyFiles: true })) {
  await Bun.write(`${output}/${relative(`${root}/public`, `${root}/public/${file}`)}`, Bun.file(`${root}/public/${file}`));
}
