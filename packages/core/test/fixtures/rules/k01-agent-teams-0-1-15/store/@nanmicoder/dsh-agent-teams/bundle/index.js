export function activate(ctx) {
  // K01 incident: this call does not exist on dsh 0.1.1-rc.2.
  ctx.subagents.registerContinuableSetup({ id: "teams" });
}
