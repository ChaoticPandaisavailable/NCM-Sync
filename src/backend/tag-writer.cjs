const fsp = require('node:fs/promises');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg';
  return null;
}

function imageDimensions(buf) {
  const type = sniffImageType(buf);
  if (type === 'image/png' && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (type === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 <= buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xff) { offset += 1; continue; }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      if (offset + 4 > buf.length) break;
      const length = buf.readUInt16BE(offset + 2);
      if (length < 2) break;
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        if (offset + 9 > buf.length) break;
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: 0, height: 0 };
}

function imageDepth(buf) {
  const type = sniffImageType(buf);
  if (type === 'image/jpeg') return 24;
  if (type === 'image/png' && buf.length >= 26) {
    const bitDepth = buf[24];
    const channels = [1, 0, 3, 1, 2, 0, 4][buf[25]] || 0;
    return bitDepth * channels;
  }
  return 0;
}

function uint32be(value) { const buf = Buffer.alloc(4); buf.writeUInt32BE(value); return buf; }
function uint32le(value) { const buf = Buffer.alloc(4); buf.writeUInt32LE(value); return buf; }

function writeSynchsafe(target, offset, value) {
  target[offset] = (value >>> 21) & 0x7f;
  target[offset + 1] = (value >>> 14) & 0x7f;
  target[offset + 2] = (value >>> 7) & 0x7f;
  target[offset + 3] = value & 0x7f;
}

function readSynchsafe(buf, offset) {
  return ((buf[offset] & 0x7f) << 21)
    | ((buf[offset + 1] & 0x7f) << 14)
    | ((buf[offset + 2] & 0x7f) << 7)
    | (buf[offset + 3] & 0x7f);
}

function buildTextFrame(id, text) {
  const value = Buffer.from(String(text), 'utf8');
  const payload = Buffer.concat([Buffer.from([0x03]), value]);
  return Buffer.concat([Buffer.from(id, 'ascii'), uint32be(payload.length), Buffer.alloc(2), payload]);
}

function buildApicFrame(cover) {
  const mime = sniffImageType(cover) || 'image/jpeg';
  const mimeBuf = Buffer.from(mime, 'ascii');
  const payload = Buffer.concat([
    Buffer.from([0x03]), mimeBuf, Buffer.from([0]), Buffer.from([0x03]), Buffer.from([0]), cover
  ]);
  return Buffer.concat([Buffer.from('APIC', 'ascii'), uint32be(payload.length), Buffer.alloc(2), payload]);
}

function buildId3v2Tag({ title = '', artist = '', album = '', cover = null } = {}) {
  const frames = [];
  if (title) frames.push(buildTextFrame('TIT2', title));
  if (artist) frames.push(buildTextFrame('TPE1', artist));
  if (album) frames.push(buildTextFrame('TALB', album));
  if (Buffer.isBuffer(cover) && cover.length) frames.push(buildApicFrame(cover));
  const body = Buffer.concat(frames);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = 0x03;
  header[4] = 0x00;
  header[5] = 0x00;
  writeSynchsafe(header, 6, body.length);
  return Buffer.concat([header, body]);
}

async function writeMp3Tags(filePath, meta) {
  const tag = buildId3v2Tag(meta);
  const data = await fsp.readFile(filePath);
  let audio = data;
  if (audio.length >= 10 && audio.subarray(0, 3).toString('ascii') === 'ID3') {
    const size = readSynchsafe(audio, 6);
    const tagEnd = 10 + size;
    if (tagEnd <= audio.length) audio = audio.subarray(tagEnd);
  }
  await fsp.writeFile(filePath, Buffer.concat([tag, audio]));
}

function buildVorbisComment({ title = '', artist = '', album = '' }) {
  const entries = [];
  for (const [key, value] of [['TITLE', title], ['ARTIST', artist], ['ALBUM', album]]) {
    if (value) {
      const entry = Buffer.from(`${key}=${value}`, 'utf8');
      entries.push(Buffer.concat([uint32le(entry.length), entry]));
    }
  }
  const vendor = Buffer.from('NCM Sync', 'utf8');
  return Buffer.concat([uint32le(vendor.length), vendor, uint32le(entries.length), ...entries]);
}

function buildPictureData(cover) {
  const mime = sniffImageType(cover) || 'image/jpeg';
  const mimeBuf = Buffer.from(mime, 'ascii');
  const { width, height } = imageDimensions(cover);
  const depth = imageDepth(cover);
  return Buffer.concat([
    uint32be(3), uint32be(mimeBuf.length), mimeBuf, uint32be(0), uint32be(width),
    uint32be(height), uint32be(depth), uint32be(0), uint32be(cover.length), cover
  ]);
}

function encodeBlock(type, data, last) {
  const header = Buffer.alloc(4);
  header[0] = (type & 0x7f) | (last ? 0x80 : 0);
  header[1] = (data.length >>> 16) & 0xff;
  header[2] = (data.length >>> 8) & 0xff;
  header[3] = data.length & 0xff;
  return Buffer.concat([header, data]);
}

async function writeFlacTags(filePath, meta) {
  const data = await fsp.readFile(filePath);
  if (data.length < 4 || data.subarray(0, 4).toString('ascii') !== 'fLaC') {
    throw new Error('不是有效的 FLAC 文件');
  }
  const blocks = [];
  let offset = 4;
  while (offset < data.length) {
    if (data.length - offset < 4) throw new Error('FLAC 元数据块不完整');
    const header = data[offset];
    const length = (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    if (offset + 4 + length > data.length) throw new Error('FLAC 元数据块超出文件末尾');
    blocks.push({ type: header & 0x7f, data: data.subarray(offset + 4, offset + 4 + length), last: Boolean(header & 0x80) });
    offset += 4 + length;
    if (header & 0x80) break;
  }
  if (!blocks.length) throw new Error('FLAC 缺少元数据块');
  const audio = data.subarray(offset);

  const additions = [];
  if (meta.title || meta.artist || meta.album) additions.push({ type: 4, data: buildVorbisComment(meta) });
  if (Buffer.isBuffer(meta.cover) && meta.cover.length) additions.push({ type: 6, data: buildPictureData(meta.cover) });
  if (additions.length) additions[additions.length - 1].last = true;

  const reencoded = blocks.map((block) => encodeBlock(block.type, block.data, additions.length ? false : block.last));
  const encoded = [...reencoded, ...additions.map((block) => encodeBlock(block.type, block.data, block.last))];

  await fsp.writeFile(filePath, Buffer.concat([Buffer.from('fLaC', 'ascii'), ...encoded, audio]));
}

async function writeAudioTags(filePath, extension, meta) {
  const ext = String(extension || '').toLowerCase();
  if (ext === 'mp3') await writeMp3Tags(filePath, meta);
  else if (ext === 'flac') await writeFlacTags(filePath, meta);
}

module.exports = {
  sniffImageType,
  imageDimensions,
  buildId3v2Tag,
  writeMp3Tags,
  writeFlacTags,
  writeAudioTags
};
