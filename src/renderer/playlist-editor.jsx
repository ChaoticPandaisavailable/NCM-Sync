import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPlanHistory, planHistory } from './plan-history.mjs';

const lanes = [{ action: 'add', title: '新增歌曲', hint: '同步时下载到当前目录' },
  { action: 'remove', title: '删除 / 跳过', hint: '删除本地链接；未下载歌曲跳过' },
  { action: 'keep', title: '留存 / 忽略', hint: '保留本地歌曲；未下载歌曲忽略' }];
const dragType = 'application/x-ncmsync-track';

export function PlaylistEditor({ item, blocked, syncDisabled, close, save, sync, Dialog }) {
  const tracks = useMemo(() => [...item.added, ...item.removed, ...item.existing], [item]);
  const initial = useMemo(() => Object.fromEntries(tracks.map((track) => [track.id, track.action])), [tracks]);
  const [editor, dispatch] = useReducer(planHistory, initial, createPlanHistory);
  const [saved, setSaved] = useState(initial);
  const [revision, setRevision] = useState(item.revision);
  const [dragOver, setDragOver] = useState('');
  const [message, setMessage] = useState('');
  const changed = Object.keys(editor.targets).filter((id) => editor.targets[id] !== saved[id]);
  const dirty = changed.length > 0;
  const groups = useMemo(() => Object.fromEntries(lanes.map((lane) => [lane.action, tracks.filter((track) => editor.targets[track.id] === lane.action)])), [tracks, editor.targets]);
  const container = useRef(null);
  useEffect(() => { container.current?.focus(); }, []);
  const move = (id, to) => { if (!blocked) { dispatch({ type: 'move', id, to }); setMessage(''); } };
  const finish = () => { if (!dirty || window.confirm('放弃尚未保存的歌曲方案？')) close(); };
  async function persist() {
    if (!dirty) return true;
    const result = await save(revision, changed.map((id) => ({ id, action: editor.targets[id] })));
    if (!result) return false;
    setRevision(result.revision);
    setSaved(editor.targets);
    setMessage('方案已保存。歌曲文件会在同步时修改，仍可撤回方案后再次保存。');
    return true;
  }
  function keyboard(event) {
    if (!(event.ctrlKey || event.metaKey) || blocked || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' || key === 'y') {
      event.preventDefault();
      dispatch({ type: key === 'y' || event.shiftKey ? 'redo' : 'undo' });
    }
  }
  return <Dialog title={item.displayName} subtitle={item.folderPath} close={finish} extraWide>
    <div className="playlist-editor" ref={container} tabIndex={-1} onKeyDown={keyboard}>
      <div className="editor-toolbar"><p>拖拽歌曲到另一栏，或使用歌曲旁的按钮。修改方案后再同步。</p><div>
        <button disabled={blocked || !editor.past.length} onClick={() => dispatch({ type: 'undo' })} title="Ctrl+Z">撤回</button>
        <button disabled={blocked || !editor.future.length} onClick={() => dispatch({ type: 'redo' })} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      </div></div>
      {blocked && <p className="editor-notice" role="status">扫描或同步进行中，待任务结束后可编辑方案。</p>}
      <div className="changes-grid editor-grid">{lanes.map((lane) => <section key={lane.action} data-testid={`lane-${lane.action}`}
        className={dragOver === lane.action ? 'drag-over' : ''}
        onDragOver={(event) => { if (!blocked && event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(lane.action); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(''); }}
        onDrop={(event) => {
          event.preventDefault(); setDragOver('');
          try { const payload = JSON.parse(event.dataTransfer.getData(dragType)); if (payload.playlistId === item.id) move(payload.id, lane.action); } catch { /* Ignore unrelated drag data. */ }
        }}>
        <h4>{lane.title} <b className={lane.action === 'remove' ? 'red' : ''}>{groups[lane.action].length}</b><small>{lane.hint}</small></h4>
        <EditorTrackList tracks={groups[lane.action]} action={lane.action} blocked={blocked} move={move} playlistId={item.id} />
      </section>)}</div>
      <p className="editor-status" role="status">{dirty ? `${changed.length} 首歌曲的方案尚未保存。关闭会放弃这些修改。` : message || '在线减少的歌曲按删除设置处理，默认留存。逐曲选择会覆盖全局设置。撤回只修改方案，已同步的文件操作不能撤回。'}</p>
      <div className="modal-actions"><button onClick={finish}>返回歌单</button><button disabled={blocked || !dirty} onClick={persist}>保存方案</button>
        <button className="primary" disabled={blocked || syncDisabled} onClick={async () => { if (await persist()) { const result = await sync(); if (result) close(); } }}>同步当前歌单</button>
      </div>
    </div>
  </Dialog>;
}

function EditorTrackList({ tracks, action, blocked, move, playlistId }) {
  const [page, setPage] = useState(0);
  const pageSize = 100;
  const count = Math.max(1, Math.ceil(tracks.length / pageSize));
  const current = Math.min(page, count - 1);
  return <div className="editor-track-frame"><div className="editor-track-list">
    {tracks.slice(current * pageSize, (current + 1) * pageSize).map((track) => <div className="editor-track" key={track.id}
      draggable={!blocked} data-track-id={track.id}
      onDragStart={(event) => { event.dataTransfer.setData(dragType, JSON.stringify({ id: track.id, playlistId })); event.dataTransfer.effectAllowed = 'move'; }}>
      <strong title={track.name}>{track.name}</strong><span title={(track.artists || []).join(', ')}>{(track.artists || []).join(', ') || '未知艺术家'}</span>
      <small>{track.local ? track.remoteRemoved ? '本地已有 · 在线已移除' : '本地已有' : '尚未下载'}</small>
      <div className="track-actions">{lanes.filter((lane) => lane.action !== action).map((lane) => <button key={lane.action}
        disabled={blocked} aria-label={`${track.name}：移到${lane.title}`} onClick={() => move(track.id, lane.action)}>{lane.title.split(' / ')[0]}</button>)}</div>
    </div>)}
    {!tracks.length && <p className="empty-state">将歌曲拖到这里，或使用歌曲旁的按钮</p>}
  </div>{count > 1 && <nav className="track-pagination" aria-label="方案曲目分页"><button disabled={!current} onClick={() => setPage(current - 1)}>上一页</button><span>{current + 1} / {count}</span><button disabled={current === count - 1} onClick={() => setPage(current + 1)}>下一页</button></nav>}</div>;
}

export function MappingModal({ item, onlineId, data, busy, close, submit, browse, Dialog }) {
  const [id, setId] = useState(item?.onlineId || onlineId || '');
  const [folder, setFolder] = useState(item?.folderPath || '');
  const [error, setError] = useState('');
  const choices = data.online.filter((row) => !data.local.some((local) => local.id !== item?.id && local.onlineId === row.id));
  return <Dialog title="自定义歌单映射" subtitle="一个在线歌单对应一个独立的本地目录" close={close} wide>
    <form className="mapping-form" onSubmit={async (event) => { event.preventDefault(); const result = await submit(id, folder, item?.id); if (result) close(); }}>
      <label>网易云歌单<select aria-label="映射的网易云歌单" value={id} onChange={(event) => setId(event.target.value)}><option value="">选择在线歌单</option>{choices.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label>本地文件夹<div className="mapping-path"><input aria-label="映射的本地文件夹" placeholder="选择音乐库中的文件夹，可位于任意子层级" value={folder} onChange={(event) => { setFolder(event.target.value); setError(''); }} /><button type="button" disabled={busy} onClick={() => browse(folder || data.rootPath, setFolder, setError)}>浏览…</button></div></label>
      <p className="mapping-root">音乐库：{data.rootPath}</p>
      <p className="hint">请选择音乐库中的现有目录。重新映射会保留原目录的文件，在新目录重新识别歌曲；目录名称不会随在线歌单自动改变。</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy || data.scanning || data.task.active || !id || !folder}>保存映射</button></div>
    </form>
  </Dialog>;
}
