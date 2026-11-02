// Streams one event a second for 90 s — longer than any first-byte timeout, to prove streaming works end to end.
export default defineEventHandler((event) => {
  const stream = createEventStream(event);
  const total = 90;
  let tick = 0;
  const timer = setInterval(async () => {
    tick++;
    await stream.push(`tick ${tick} at ${new Date().toISOString()}`);
    if (tick >= total) {
      clearInterval(timer);
      await stream.close();
    }
  }, 1000);
  stream.onClosed(() => clearInterval(timer));
  return stream.send();
});
