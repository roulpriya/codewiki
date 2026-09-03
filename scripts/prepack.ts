const result = Bun.spawnSync(["bun", "run", "build"], {
  cwd: import.meta.dir + "/..",
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

process.exit(result.exitCode);
