// One shared token guards every API route but the health check: the dashboard is an ops tool for
// one team, and the token lives in the stage's env as DASHBOARD_TOKEN.
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname;
  if (!path.startsWith("/api/") || path === "/api/health") return;
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) throw createError({ statusCode: 503, statusMessage: "DASHBOARD_TOKEN is not set on this stage" });
  if (getHeader(event, "authorization") !== `Bearer ${expected}`)
    throw createError({ statusCode: 401, statusMessage: "Wrong or missing token" });
});
