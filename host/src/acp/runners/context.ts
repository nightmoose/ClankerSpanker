import type { AgentProfile, DispatchSession, HostConfigFile, SessionEvent } from "../../types.js";
import type { BotRunState } from "../session-helpers.js";

/**
 * What a backend turn needs from the SessionManager (RFC-052). Keeping this
 * narrow is the point: runners can't reach into the manager's other state.
 */
export interface TurnContext {
  readonly config: HostConfigFile;
  /** Active CLI child processes (Claude / agy), by session id. */
  readonly cliRunners: Map<string, { stop: () => void }>;
  /** Active bot runs, by session id. */
  readonly botRuns: Map<string, BotRunState>;
  get(sessionId: string): DispatchSession | null;
  persist(session: DispatchSession): void;
  emitEvent(session: DispatchSession, type: SessionEvent["type"], payload: unknown): void;
  maybeNotify(title: string, message: string): void;
  profileFor(session: DispatchSession): AgentProfile | undefined;
  profileEnvFor(session: DispatchSession): NodeJS.ProcessEnv;
  buildTransferHandoffPrompt(session: DispatchSession, userMessage: string): string;
  botBrainProfile(owner: AgentProfile): AgentProfile;
}
