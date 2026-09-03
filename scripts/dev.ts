const root = import.meta.dir + "/..";
const initialBuild = Bun.spawnSync(["bun", "run", "build"], { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
if (initialBuild.exitCode !== 0) process.exit(initialBuild.exitCode);

const children = [
  Bun.spawn(["bun", "--watch", "scripts/build.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--watch", "src/web.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" }),
];

const stop = () => children.forEach((child) => child.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.exit(await Promise.race(children.map((child) => child.exited)));
