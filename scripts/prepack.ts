const result = Bun.spawnSync(["bunx", "vinext", "build"], {
  cwd: import.meta.dir + "/..",
  env: { ...process.env, API_ORIGIN: "http://127.0.0.1:3001" },
  stdio: ["inherit", "inherit", "inherit"],
});

process.exit(result.exitCode);
