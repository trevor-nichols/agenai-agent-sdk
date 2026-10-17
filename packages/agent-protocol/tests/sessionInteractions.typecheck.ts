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
const response = parseAgentSessionDecisionResponse({ kind: 'decision', choiceId });
void [requestId, foreignChoice, consequence, response];

import {
  parseAgentSessionFormChoiceId,
  parseAgentSessionPlanReviewChoiceId,
  parseAgentSessionPlanId,
  parseAgentSessionPlanRevision,
  parseAgentSessionFormRequest,
  type AgentSessionDecisionResponse,
  type AgentSessionFormChoiceId,
  type AgentSessionPlanReviewChoiceId,
  type AgentSessionPlanId,
  type AgentSessionPlanRevision,
} from '../src/public/sessionInteractions.js';

const formChoice: AgentSessionFormChoiceId = parseAgentSessionFormChoiceId('submit');
const planChoice: AgentSessionPlanReviewChoiceId = parseAgentSessionPlanReviewChoiceId('approve');
const planId: AgentSessionPlanId = parseAgentSessionPlanId('plan:1');
const revision: AgentSessionPlanRevision = parseAgentSessionPlanRevision('revision:1');
// @ts-expect-error Form choices cannot supply a workspace decision choice.
const wrongDecision: AgentSessionDecisionChoiceId = formChoice;
// @ts-expect-error Review choices cannot supply a form choice.
const wrongForm: AgentSessionFormChoiceId = planChoice;
// @ts-expect-error Plan identity cannot supply a revision identity.
const wrongRevision: AgentSessionPlanRevision = planId;
// @ts-expect-error Revision identity cannot supply a review choice.
const wrongReview: AgentSessionPlanReviewChoiceId = revision;
// @ts-expect-error V12 decision responses require their discriminant.
const untagged: AgentSessionDecisionResponse = { choiceId };
const form = parseAgentSessionFormRequest({});
const firstField = form.fields[0];
// @ts-expect-error A parsed nonempty field list is immutable.
form.fields.push(firstField);
void [wrongDecision, wrongForm, wrongRevision, wrongReview, untagged];
