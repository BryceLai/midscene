process.on('disconnect', () => process.exit(1));
process.on('message', () => {
  process.send({ type: 'progress', progress: { pid: process.pid } });
  setInterval(() => {}, 1000);
});
