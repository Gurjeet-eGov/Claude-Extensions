// Chrome native messaging framing: 4-byte little-endian length + UTF-8 JSON.

export async function* readMessages(stream) {
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch {
        continue;
      }
      yield msg;
    }
  }
}

const MAX_OUT = 1024 * 1024; // Chrome's limit for messages from the helper

export function writeMessage(obj) {
  let json = Buffer.from(JSON.stringify(obj), 'utf8');
  if (json.length > MAX_OUT) {
    json = Buffer.from(JSON.stringify({ id: obj.id, type: 'error', error: { code: 'TOO_LARGE', message: 'Helper response too large' } }));
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}
