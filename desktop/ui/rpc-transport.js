// WebView adapter for docs/rpc.md protocol v2. One decoder per omp process.
(() => {
  const MAX_BYTES = 64 * 1024 * 1024;
  const CHUNK_BYTES = 256 * 1024;
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  window.KostompRpcDecoder = class {
    #pending = null;
    reset() { this.#pending = null; }
    push(frame) {
      try {
        return this.#push(frame);
      } catch (error) {
        this.reset();
        throw error;
      }
    }
    #push(frame) {
      if (!isObject(frame)) throw new Error("RPC frame must be an object");
      if (frame.type !== "rpc_chunk") {
        if (this.#pending) throw new Error("RPC chunk sequence interrupted");
        return frame;
      }
      const { chunkId, index, count, byteLength, data } = frame;
      if (typeof chunkId !== "string" || !chunkId || chunkId.length > 128 ||
          !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) ||
          index < 0 || index >= count || count < 2 || count > MAX_BYTES / CHUNK_BYTES ||
          byteLength < 1024 * 1024 || byteLength > MAX_BYTES) throw new Error("Invalid RPC chunk metadata");
      if (typeof data !== "string" || !data || data.length > 4 * Math.ceil(CHUNK_BYTES / 3) ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("Invalid RPC chunk data");
      const raw = atob(data);
      if (raw.length > CHUNK_BYTES || btoa(raw) !== data) throw new Error("Invalid RPC chunk data");
      if (!this.#pending) {
        if (index !== 0) throw new Error("RPC chunk sequence must start at index 0");
        this.#pending = { chunkId, count, byteLength, next: 0, received: 0, bytes: new Uint8Array(byteLength) };
      }
      const p = this.#pending;
      if (p.chunkId !== chunkId || p.count !== count || p.byteLength !== byteLength || p.next !== index) throw new Error("RPC chunk sequence mismatch");
      if (p.received + raw.length > byteLength) throw new Error("RPC chunk sequence exceeds declared length");
      for (let i = 0; i < raw.length; i++) p.bytes[p.received + i] = raw.charCodeAt(i);
      p.received += raw.length;
      p.next++;
      if (p.next < count) return undefined;
      if (p.received !== byteLength) throw new Error("RPC chunk sequence length mismatch");
      this.reset();
      const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(p.bytes));
      if (!isObject(decoded) || decoded.type === "rpc_chunk") throw new Error("Invalid reassembled RPC frame");
      return decoded;
    }
  };
})();
