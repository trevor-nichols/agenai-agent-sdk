// ------------------------------------------------------------------------------------------------
//                controlCharacters.ts - Shared runtime control-character detection - Dependencies: none
// ------------------------------------------------------------------------------------------------

const AGENT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

export function containsAgentControlCharacter(value: string): boolean {
  return AGENT_CONTROL_CHARACTER_PATTERN.test(value);
}
