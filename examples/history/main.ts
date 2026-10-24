// ------------------------------------------------------------------------------------------------
//                Run the bundled history example without optional native peers
// ------------------------------------------------------------------------------------------------

import { browseHistory } from './browse.js';
import { createFixtureHistory, FIXTURE_SELECTED_CONVERSATION_ID } from './fixture.js';
import { summarizeHistory } from './summary.js';

const result = await browseHistory(createFixtureHistory(), {
  selectConversation: (conversation) => conversation.ref.conversationId === FIXTURE_SELECTED_CONVERSATION_ID,
  pageSize: 1,
  maxPages: 32,
});
process.stdout.write(`${JSON.stringify(summarizeHistory(result), null, 2)}\n`);
