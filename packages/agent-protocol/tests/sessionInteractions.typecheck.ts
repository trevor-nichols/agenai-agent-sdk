import {
  parseAgentRequestId,
  parseAgentSessionDecisionChoiceId,
  parseAgentSessionDecisionRequest,
  type AgentRequestId,
  type AgentSessionDecisionChoice,
  type AgentSessionDecisionChoiceId,
  type AgentSessionDecisionRequest,
} from '../src/public/index.js';
import { parseAgentSessionDecisionResponse } from '../src/public/sessionInteractions.js';

const choiceId: AgentSessionDecisionChoiceId = parseAgentSessionDecisionChoiceId('grant');
// @ts-expect-error Session choice IDs cannot supply request identity.
const requestId: AgentRequestId = choiceId;
// @ts-expect-error Request identity cannot supply a session choice.
const foreignChoice: AgentSessionDecisionChoiceId = parseAgentRequestId('request:1');

const request: AgentSessionDecisionRequest = parseAgentSessionDecisionRequest({});
const first: AgentSessionDecisionChoice = request.choices[0];
// @ts-expect-error A parsed nonempty choice list is immutable.
request.choices.push(first);
// @ts-expect-error Session choices cannot use an unsupported consequence.
const consequence: AgentSessionDecisionChoice['consequence'] = { kind: 'cancel' };
const response = parseAgentSessionDecisionResponse({ choiceId });
void [requestId, foreignChoice, consequence, response];
