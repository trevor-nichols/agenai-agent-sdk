import assert from 'node:assert/strict';

/** A qualification-only observer: two bounded framing layers, no SDK hooks or guest control. */
export class PublicationGate {
  constructor(onPublication, onReady) {
    this.onPublication = onPublication;
    this.onReady = onReady;
    this.engine = Buffer.alloc(0);
    this.native = Buffer.alloc(0);
    this.armed = false;
    this.captured = null;
    this.frames = 0;
    this.commands = Buffer.alloc(0);
    this.commandCounts = {};
  }

  observeInput(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const headerNeed = Math.max(0, 16 - this.commands.length);
      const needed = headerNeed || 16 + this.commands.readUInt32BE(8) + this.commands.readUInt32BE(12) - this.commands.length;
      const take = Math.min(needed, chunk.length - offset);
      this.commands = Buffer.concat([this.commands, chunk.subarray(offset, offset + take)]); offset += take;
      if (this.commands.length < 16) continue;
      const operation = this.commands.readUInt32BE(0); const pathLength = this.commands.readUInt32BE(8); const payloadLength = this.commands.readUInt32BE(12);
      assert(operation >= 1 && operation <= 10 && pathLength <= 4079 && payloadLength <= 65536, 'Invalid bounded helper command');
      if (this.commands.length < 16 + pathLength + payloadLength) continue;
      this.commandCounts[operation] = (this.commandCounts[operation] ?? 0) + 1;
      this.commands = Buffer.alloc(0);
    }
  }

  async observe(chunk, forward) {
    let offset = 0;
    while (offset < chunk.length) {
      const headerNeed = Math.max(0, 8 - this.engine.length);
      const needed = headerNeed || 8 + this.engine.readUInt32BE(4) - this.engine.length;
      const take = Math.min(needed, chunk.length - offset);
      this.engine = Buffer.concat([this.engine, chunk.subarray(offset, offset + take)]);
      offset += take;
      if (this.engine.length < 8) continue;
      const kind = this.engine[0]; const length = this.engine.readUInt32BE(4);
      assert((kind === 1 || kind === 2) && this.engine.subarray(1, 4).equals(Buffer.alloc(3)), 'Invalid owned Engine frame');
      assert(length <= 65536, 'Owned Engine frame exceeded 64 KiB');
      if (this.engine.length < length + 8) continue;
      const frame = this.engine; this.engine = Buffer.alloc(0);
      if (kind === 2) { await forward(frame); continue; }
      if (await this.stdout(frame.subarray(8), forward) === 'close') return 'close';
    }
  }

  async stdout(bytes, forward) {
    let offset = 0;
    while (offset < bytes.length) {
      const headerNeed = Math.max(0, 8 - this.native.length);
      const needed = headerNeed || 8 + this.native.readUInt32BE(4) - this.native.length;
      const take = Math.min(needed, bytes.length - offset);
      this.native = Buffer.concat([this.native, bytes.subarray(offset, offset + take)]);
      offset += take;
      if (this.native.length < 8) continue;
      const kind = this.native.readUInt32BE(0); const length = this.native.readUInt32BE(4);
      assert(kind >= 1 && kind <= 5 && length <= (kind === 1 ? 65536 : 2048), 'Invalid bounded helper reply frame');
      assert(kind !== 5 || length === 0, 'Heartbeat must have no payload');
      if (this.native.length < length + 8) continue;
      const frame = this.native; this.native = Buffer.alloc(0); this.frames++;
      if (kind === 4 && this.onReady) await this.onReady({
        readiness: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(8))),
        nativeFrameBase64: frame.toString('base64'), atFrame: this.frames,
      });
      if (kind === 3) {
        const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(8)));
        if (this.armed && receipt.effect === 'published') {
          assert.equal(receipt.status, 'complete'); assert.equal(receipt.errno, 0);
          assert.equal(typeof receipt.count, 'string'); assert(/^(?:0|[1-9][0-9]*)$/u.test(receipt.count));
          assert.equal(this.captured, null, 'Only one acknowledged publication can be withheld');
          this.captured = { receipt, nativeFrameBase64: frame.toString('base64'), atFrame: this.frames };
          await this.onPublication(this.captured);
          return 'close';
        }
      }
      for (let start = 0; start < frame.length; start += 65536) {
        const part = frame.subarray(start, start + 65536);
        const engine = Buffer.alloc(8 + part.length); engine[0] = 1; engine.writeUInt32BE(part.length, 4); part.copy(engine, 8);
        await forward(engine);
      }
    }
  }
}
