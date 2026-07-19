const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileStore } = require('../../src/backend/file-store.cjs');
const { CORE_KEY, buildKeyBox, cryptAudioChunk } = require('../../src/backend/ncm-decoder.cjs');

test('内置 NCM 解码器会自动转换为标准 MP3，无需外部程序', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-ncm-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('cloudmusic-ncm-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const audio = Buffer.concat([Buffer.from('ID3\u0004\u0000\u0000', 'binary'), Buffer.alloc(4096, 7)]);
  const response = new Response(createNcmFixture(audio));
  const store = new FileStore(root);
  const track = { id: '7', name: 'VIP Track', artists: ['Artist'] };
  const downloaded = await store.downloadTrack(track, response, {
    waitIfPaused: async () => {}, throwIfCancelled: () => {}
  });
  assert.equal(downloaded.encrypted, true);
  const decoded = await store.finishNcm(track, downloaded.ncmPath);
  assert.equal(decoded.extension, 'mp3');
  assert.equal(fs.readFileSync(decoded.entityPath).subarray(0, 3).toString('ascii'), 'ID3');
  assert.deepEqual(fs.readFileSync(decoded.entityPath), audio);
  assert.equal(fs.existsSync(downloaded.ncmPath), false);
});

function createNcmFixture(audio) {
  const audioKey = Buffer.from('test-audio-key');
  const plainKey = Buffer.concat([Buffer.from('neteasecloudmusic'), audioKey]);
  const cipher = crypto.createCipheriv('aes-128-ecb', CORE_KEY, null);
  const encryptedKey = Buffer.concat([cipher.update(plainKey), cipher.final()]);
  for (let index = 0; index < encryptedKey.length; index += 1) encryptedKey[index] ^= 0x64;
  const keyLength = Buffer.alloc(4); keyLength.writeUInt32LE(encryptedKey.length);
  const zeroLength = Buffer.alloc(4);
  const encryptedAudio = cryptAudioChunk(audio, buildKeyBox(audioKey));
  return Buffer.concat([
    Buffer.from('CTENFDAM'), Buffer.alloc(2), keyLength, encryptedKey,
    zeroLength, Buffer.alloc(9), zeroLength, encryptedAudio
  ]);
}
