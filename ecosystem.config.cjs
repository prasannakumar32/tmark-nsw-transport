module.exports = {
  apps: [
    {
      name: "tmark-train-worker",
      cwd: __dirname,
      script: "npm",
      args: "run start:train-worker",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
    },
  ],
};
