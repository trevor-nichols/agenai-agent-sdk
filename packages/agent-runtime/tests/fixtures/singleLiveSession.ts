// ------------------------------------------------------------------------------------------------
//                singleLiveSession.ts - A driver whose instance admits one live session at a time
// ------------------------------------------------------------------------------------------------
import type { AgentProviderDriver, AgentProviderSession, MaybePromise } from "../../src/index.js";

/**
 * Admits one live session per instance, as the owned Claude and OpenCode drivers do: an opening while
 * another session is live (or still opening) rejects, and a successful close frees the instance.
 */
export function singleLiveSession(driver: AgentProviderDriver): AgentProviderDriver {
  return { ...driver, async materialize(definition) {
    const instance = await driver.materialize(definition);
    let live: string | undefined;
    const admit = async (sessionId: string, open: () => MaybePromise<AgentProviderSession>): Promise<AgentProviderSession> => {
      if (live !== undefined) throw new Error(`Session ${live} is still live; this instance admits one live session.`);
      live = sessionId;
      let session: AgentProviderSession;
      try { session = await open(); } catch (error) { live = undefined; throw error; }
      return { ...session, async close(input) {
        await session.close(input);
        if (live === sessionId) live = undefined;
      } };
    };
    const { resumption, branching } = instance.adapter;
    return { ...instance, adapter: { ...instance.adapter,
      createSession: (input) => admit(input.sessionId, () => instance.adapter.createSession(input)),
      resumption: resumption.kind === "unsupported" ? resumption
        : { kind: "supported", resumeSession: (input) => admit(input.sessionId, () => resumption.resumeSession(input)) },
      branching: branching.kind === "unsupported" ? branching
        : { kind: "through_turn", branchSession: (input) => admit(input.sessionId, () => branching.branchSession(input)) },
    } };
  } };
}
