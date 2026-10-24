globalThis.fetch = () => { throw new Error('History root proof cannot access the network'); };
globalThis.WebSocket = class {
  constructor() { throw new Error('History root proof cannot open a WebSocket'); }
};
