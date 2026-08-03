// Vercel's native Express support auto-detects an Express app exported
// from a root-level (or src/) file named app/index/server.{js,ts,...}.
// This just re-exports the real app defined in server/app.ts — local dev
// still runs it via server/index.ts's app.listen().
export { default } from "./server/app.js";
