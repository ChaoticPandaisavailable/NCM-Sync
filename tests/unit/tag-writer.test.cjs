const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sniffImageType,
  imageDimensions,
  buildId3v2Tag,
  writeMp3Tags,
  writeFlacTags
} = require('../../src/backend/tag-writer.cjs');

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x2d, 0x00, 0x40, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9
]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x2d,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x00
]);

test('sniffImageType 按魔数识别图片类型', () => {
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(Buffer.from([0x00, 0x01, 0x02, 0x03])), null);
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test('imageDimensions 解析 JPEG 与 PNG 尺寸，未知图片返回 0', () => {
  assert.deepEqual(imageDimensions(JPEG), { width: 64, height: 45 });
  assert.deepEqual(imageDimensions(PNG), { width: 64, height: 45 });
  assert.deepEqual(imageDimensions(Buffer.from([0x00, 0x01, 0x02])), { width: 0, height: 0 });
});

test('buildId3v2Tag 生成符合 ID3v2.3 的标签', () => {
  const tag = buildId3v2Tag({ title: '标题', artist: '歌手', album: '专辑', cover: JPEG });
  assert.equal(tag.subarray(0, 3).toString('ascii'), 'ID3');
  assert.equal(tag[3], 0x03);
  assert.equal(tag[4], 0x00);
  assert.equal(readSynchsafe(tag, 6), tag.length - 10);
  const frames = parseId3Frames(tag);
  assert.equal(frames.TIT2[0], 0x03);
  assert.equal(frames.TIT2.subarray(1).toString('utf8'), '标题');
  assert.equal(frames.TPE1.subarray(1).toString('utf8'), '歌手');
  assert.equal(frames.TALB.subarray(1).toString('utf8'), '专辑');
  const apic = frames.APIC;
  assert.equal(apic[0], 0x03);
  const mimeEnd = apic.indexOf(0, 1);
  assert.equal(apic.subarray(1, mimeEnd).toString('ascii'), 'image/jpeg');
  assert.equal(apic[mimeEnd + 1], 0x03);
  assert.equal(apic[mimeEnd + 2], 0x00);
  assert.deepEqual(apic.subarray(mimeEnd + 3), JPEG);
});

test('buildId3v2Tag 无封面时不产生 APIC 帧', () => {
  const frames = parseId3Frames(buildId3v2Tag({ title: 'T', artist: 'A', album: 'B' }));
  assert.ok(frames.TIT2);
  assert.ok(!frames.APIC);
});

test('buildId3v2Tag 空元数据时仅生成 10 字节头', () => {
  const tag = buildId3v2Tag({});
  assert.equal(tag.subarray(0, 3).toString('ascii'), 'ID3');
  assert.equal(readSynchsafe(tag, 6), 0);
  assert.equal(tag.length, 10);
});

test('writeMp3Tags 前置新标签并保留音频载荷', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagwriter-mp3-'));
  const file = path.join(dir, 'song.mp3');
  const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(512, 0x55)]);
  fs.writeFileSync(file, audio);
  await writeMp3Tags(file, { title: 'Song', artist: 'Artist', album: 'Album', cover: JPEG });
  const output = fs.readFileSync(file);
  assert.equal(output.subarray(0, 3).toString('ascii'), 'ID3');
  assert.deepEqual(output.subarray(10 + readSynchsafe(output, 6)), audio);
  assert.ok(output.includes(JPEG));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeMp3Tags 会剥掉文件已有的 ID3 标签', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagwriter-mp3-strip-'));
  const file = path.join(dir, 'song.mp3');
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0xaa, 0xaa, 0xaa, 0xaa]);
  const oldFrames = Buffer.concat([
    Buffer.from('TIT2'), Buffer.from([0, 0, 0, 3]), Buffer.from([0, 0]), Buffer.from([0x03]), Buffer.from('X')
  ]);
  const oldTag = Buffer.concat([
    Buffer.from('ID3'), Buffer.from([0x03, 0x00, 0x00]), Buffer.from([0, 0, 0, oldFrames.length]), oldFrames
  ]);
  fs.writeFileSync(file, Buffer.concat([oldTag, audio]));
  await writeMp3Tags(file, { title: 'New', artist: '', album: '', cover: null });
  const output = fs.readFileSync(file);
  assert.equal(output.subarray(0, 3).toString('ascii'), 'ID3');
  assert.deepEqual(output.subarray(10 + readSynchsafe(output, 6)), audio);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFlacTags 在 STREAMINFO 后插入注释与封面块', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagwriter-flac-'));
  const file = path.join(dir, 'song.flac');
  const streamInfo = Buffer.alloc(34, 0x11);
  const audioFrames = Buffer.alloc(256, 0xaa);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('fLaC', 'ascii'), encodeFlacBlock(0, streamInfo, true), audioFrames]));
  await writeFlacTags(file, { title: '标题', artist: '歌手', album: '专辑', cover: JPEG });
  const output = fs.readFileSync(file);
  const { blocks, audioStart } = parseFlacBlocks(output);
  assert.deepEqual(blocks.map((block) => block.type), [0, 4, 6]);
  assert.equal(blocks[0].last, false);
  assert.equal(blocks[1].last, false);
  assert.equal(blocks[2].last, true);
  assert.deepEqual(blocks[0].data, streamInfo);
  const comment = blocks[1].data.toString('utf8');
  assert.ok(comment.includes('TITLE=标题'));
  assert.ok(comment.includes('ARTIST=歌手'));
  assert.ok(comment.includes('ALBUM=专辑'));
  const pic = blocks[2].data;
  assert.equal(pic.readUInt32BE(0), 3);
  const mimeLen = pic.readUInt32BE(4);
  assert.equal(pic.subarray(8, 8 + mimeLen).toString('ascii'), 'image/jpeg');
  const dimsOffset = 8 + mimeLen;
  assert.equal(pic.readUInt32BE(dimsOffset), 0);
  assert.equal(pic.readUInt32BE(dimsOffset + 4), 64);
  assert.equal(pic.readUInt32BE(dimsOffset + 8), 45);
  assert.ok(pic.includes(JPEG));
  assert.deepEqual(output.subarray(audioStart), audioFrames);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFlacTags 拒绝非 FLAC 文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagwriter-flac-bad-'));
  const file = path.join(dir, 'bad.flac');
  fs.writeFileSync(file, Buffer.from('MPEG audio bytes'));
  await assert.rejects(writeFlacTags(file, { title: 'T' }), /不是有效的 FLAC 文件/);
  fs.rmSync(dir, { recursive: true, force: true });
});

function readSynchsafe(buf, offset) {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14) | ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f);
}

function parseId3Frames(buf) {
  const frames = {};
  const size = readSynchsafe(buf, 6);
  let offset = 10;
  const end = 10 + size;
  while (offset + 10 <= end) {
    const id = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const length = buf.readUInt32BE(offset + 4);
    frames[id] = buf.subarray(offset + 10, offset + 10 + length);
    offset += 10 + length;
  }
  return frames;
}

function encodeFlacBlock(type, data, last) {
  const header = Buffer.alloc(4);
  header[0] = (type & 0x7f) | (last ? 0x80 : 0);
  header[1] = (data.length >>> 16) & 0xff;
  header[2] = (data.length >>> 8) & 0xff;
  header[3] = data.length & 0xff;
  return Buffer.concat([header, data]);
}

function parseFlacBlocks(buf) {
  const blocks = [];
  let offset = 4;
  while (offset + 4 <= buf.length) {
    const header = buf[offset];
    const length = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    blocks.push({ type: header & 0x7f, last: Boolean(header & 0x80), data: buf.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
    if (header & 0x80) break;
  }
  return { blocks, audioStart: offset };
}
