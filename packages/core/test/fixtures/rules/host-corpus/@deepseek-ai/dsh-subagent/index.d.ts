/**
 * Synthetic host API corpus for the static K matrix.
 *
 * Stands in for the dsh 0.1.1-rc.2 subagent service declarations: it exposes
 * `registerSetup` but NOT `registerContinuableSetup`, which the AgentTeams
 * 0.1.15 bundle calls (the K01 incident).
 */
export interface SubagentsService {
  registerSetup(options: RegisterSetupOptions): void;
  listSessions(): readonly string[];
}

export declare function registerSetup(options: RegisterSetupOptions): void;
