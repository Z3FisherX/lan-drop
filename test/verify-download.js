'use strict';

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert').strict;

async function verify() {
  const [url, source] = process.argv.slice(2);
  if (!url || !source) throw new Error('Usage: node test/verify-download.js <http-url> <source-file>');
  const expectedHash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(source)) expectedHash.update(chunk);
  const expected = expectedHash.digest('hex');
  const expectedSize = fs.statSync(source).size;
  const result = await new Promise((resolve, reject) => {
    const req = http.get(url, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
      const hash = crypto.createHash('sha256');
      let size = 0;
      response.on('data', chunk => { hash.update(chunk); size += chunk.length; });
      response.on('error', reject);
      response.on('end', () => resolve({ url, size, sha256: hash.digest('hex'), disposition: response.headers['content-disposition'] }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Download stalled')));
  });
  assert.equal(result.size, expectedSize, 'Downloaded size mismatch');
  assert.equal(result.sha256, expected, 'Downloaded SHA-256 mismatch');
  console.log(JSON.stringify({ verified: true, ...result }, null, 2));
}
verify().catch(err => { console.error(err); process.exitCode = 1; });
