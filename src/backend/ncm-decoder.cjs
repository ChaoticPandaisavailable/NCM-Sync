const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAGIC = Buffer.from('CTENFDAM', 'ascii');
const CORE_KEY = Buffer.from('hzHRAmso5kInbaxW', 'utf8');
const META_KEY = Buffer.from('#14ljk_!\\]&0U<\'(', 'utf8');
const MAX_SECTION_SIZE = 16 * 1024 * 1024;

function aesEcbDecrypt(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function buildKeyBox(key) {
  if (!key?.length) throw new Error('NCM 密钥为空');
  const box = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  let lastByte = 0;
  let keyOffset = 0;
  for (let index = 0; index < 256; index += 1) {
    const swap = box[index];
    const cursor = (swap + lastByte + key[keyOffset]) & 0xff;
    keyOffset = (keyOffset + 1) % key.length;
    box[index] = box[cursor];
    box[cursor] = swap;
    lastByte = cursor;
  }
  return box;
}

function cryptAudioChunk(chunk, keyBox, startOffset = 0) {
  const output = Buffer.from(chunk);
  for (let index = 0; index < output.length; index += 1) {
    const cursor = ((startOffset + index) + 1) & 0xff;
    const keyByte = keyBox[(keyBox[cursor] + keyBox[(keyBox[cursor] + cursor) & 0xff]) & 0xff];
    output[index] ^= keyByte;
  }
  return output;
}

async function readExact(handle, length, position) {
  if (!Number.isInteger(length) || length < 0 || length > MAX_SECTION_SIZE) throw new Error('NCM 区段长度无效');
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('NCM 文件不完整');
  return buffer;
}

async function parseNcm(inputPath) {
  const handle = await fsp.open(inputPath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < 32) throw new Error('NCM 文件过小');
    const magic = await readExact(handle, 8, 0);
    if (!magic.equals(MAGIC)) throw new Error('不是有效的 NCM 文件');
    let position = 10;
    const keyLength = (await readExact(handle, 4, position)).readUInt32LE(0); position += 4;
    const encryptedKey = await readExact(handle, keyLength, position); position += keyLength;
    for (let index = 0; index < encryptedKey.length; index += 1) encryptedKey[index] ^= 0x64;
    const plainKey = aesEcbDecrypt(encryptedKey, CORE_KEY);
    if (plainKey.length <= 17) throw new Error('NCM 音频密钥损坏');
    const keyBox = buildKeyBox(plainKey.subarray(17));

    const metaLength = (await readExact(handle, 4, position)).readUInt32LE(0); position += 4;
    let metadata = {};
    if (metaLength > 0) {
      const encryptedMeta = await readExact(handle, metaLength, position); position += metaLength;
      for (let index = 0; index < encryptedMeta.length; index += 1) encryptedMeta[index] ^= 0x63;
      try {
        const decoded = Buffer.from(encryptedMeta.subarray(22).toString('utf8'), 'base64');
        const plainMeta = aesEcbDecrypt(decoded, META_KEY).toString('utf8').replace(/^music:/, '');
        metadata = JSON.parse(plainMeta);
      } catch { metadata = {}; }
    }
    position += 9;
    const imageLength = (await readExact(handle, 4, position)).readUInt32LE(0); position += 4;
    if (imageLength > MAX_SECTION_SIZE || position + imageLength >= stat.size) throw new Error('NCM 封面区段损坏');
    position += imageLength;
    return { audioOffset: position, keyBox, metadata, size: stat.size };
  } finally { await handle.close(); }
}

function detectAudioExtension(header, metadata = {}) {
  const format = String(metadata.format || '').toLowerCase();
  if (format === 'mp3' || format === 'flac') return format;
  if (header.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (header.subarray(0, 3).toString('ascii') === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) return 'mp3';
  throw new Error('NCM 解密成功，但无法识别音频格式');
}

async function decodeNcm(inputPath, outputBasePath) {
  const parsed = await parseNcm(inputPath);
  const encryptedHead = await fsp.open(inputPath, 'r');
  let head;
  try { head = (await encryptedHead.read(Buffer.alloc(12), 0, 12, parsed.audioOffset)).buffer; }
  finally { await encryptedHead.close(); }
  const extension = detectAudioExtension(cryptAudioChunk(head, parsed.keyBox), parsed.metadata);
  const outputPath = `${outputBasePath}.${extension}`;
  const partialPath = `${outputPath}.partial`;
  let offset = 0;
  const decoder = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const decoded = cryptAudioChunk(chunk, parsed.keyBox, offset);
        offset += chunk.length;
        callback(null, decoded);
      } catch (error) { callback(error); }
    }
  });
  try {
    await pipeline(
      fs.createReadStream(inputPath, { start: parsed.audioOffset, highWaterMark: 0x8000 }),
      decoder,
      fs.createWriteStream(partialPath, { flags: 'w' })
    );
    await fsp.rename(partialPath, outputPath);
    return { outputPath, extension, metadata: parsed.metadata };
  } catch (error) {
    await fsp.rm(partialPath, { force: true });
    throw error;
  }
}

module.exports = {
  MAGIC,
  CORE_KEY,
  META_KEY,
  aesEcbDecrypt,
  buildKeyBox,
  cryptAudioChunk,
  detectAudioExtension,
  parseNcm,
  decodeNcm
};
