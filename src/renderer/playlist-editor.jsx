import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPlanHistory, planHistory } from './plan-history.mjs';

const lanes = [{ action: 'add', title: '新增歌曲', hint: '勾选后下载到当前目录' },
  { action: 'remove', title: '删除 / 跳过', hint: '勾选后删除本地歌曲链接' },
  { action: 'keep', title: '留存 / 忽略', hint: '保留本地歌曲，忽略未下载歌曲' }];
const dragType = 'application/x-ncmsync-track';

export function PlaylistEditor({ item, blocked, syncDisabled, close, save, sync, Dialog }) {
  const tracks = useMemo(() => [...item.added, ...item.removed, ...item.existing], [item]);
  const initial = useMemo(() => Object.fromEntries(tracks.map((track) => [track.id, track.action])), [tracks]);
  const initialEnabled = useMemo(() => Object.fromEntries(tracks.map((track) => [track.id, track.syncSelected])), [tracks]);
  const [editor, dispatch] = useReducer(planHistory, null, () => createPlanHistory(initial, initialEnabled));
  const [saved, setSaved] = useState({ targets: initial, enabled: initialEnabled });
  const [revision, setRevision] = useState(item.revision);
  const [dragOver, setDragOver] = useState('');
  const [message, setMessage] = useState('');
  const changed = Object.keys(editor.targets).filter((id) => editor.targets[id] !== saved.targets[id] || editor.enabled[id] !== saved.enabled[id]);
  const selectedCount = tracks.filter((track) => editor.enabled[track.id]).length;
  const downloadCount = tracks.filter((track) => !track.local && editor.enabled[track.id] && editor.targets[track.id] === 'add').length;
  const removeCount = tracks.filter((track) => track.local && editor.enabled[track.id] && editor.targets[track.id] === 'remove').length;
  const dirty = changed.length > 0;
  const groups = useMemo(() => Object.fromEntries(lanes.map((lane) => [lane.action, tracks.filter((track) => editor.targets[track.id] === lane.action)])), [tracks, editor.targets]);
  const container = useRef(null);
  useEffect(() => { container.current?.focus(); }, []);
  const move = (id, to) => {
    if (!blocked) {
      const track = tracks.find((track) => track.id === id);
      dispatch({ type: 'move', id, to, enabled: to === 'add' || to === 'remove' || Boolean(track?.local) }); setMessage('');
    }
  };
  const selectTracks = (items, enabled) => {
    if (blocked) return;
    dispatch({ type: 'batch', changes: items.map((track) => ({ id: track.id, enabled,
      to: enabled && !track.local ? 'add' : !enabled ? 'keep' : editor.targets[track.id] })) });
    setMessage('');
  };
  const finish = () => { if (!dirty || window.confirm('放弃尚未保存的歌曲方案？')) close(); };
  async function persist() {
    if (!dirty) return true;
    const result = await save(revision, changed.map((id) => ({ id, action: editor.targets[id], enabled: editor.enabled[id] })));
    if (!result) return false;
    setRevision(result.revision);
    setSaved({ targets: editor.targets, enabled: editor.enabled });
    setMessage('选择已保存，未勾选的歌曲保持原样。');
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
      <div className="editor-toolbar"><div className="song-selection-controls">
        <button disabled={blocked || selectedCount === tracks.length} onClick={() => selectTracks(tracks, true)}>全选歌曲</button>
        <button disabled={blocked || !selectedCount} onClick={() => selectTracks(tracks, false)}>取消全选歌曲</button>
        <span>已选 {selectedCount} / {tracks.length} · 下载 {downloadCount} · 删除 {removeCount}</span>
      </div><div>
        <button disabled={blocked || !editor.past.length} onClick={() => dispatch({ type: 'undo' })} title="Ctrl+Z">撤回</button>
        <button disabled={blocked || !editor.future.length} onClick={() => dispatch({ type: 'redo' })} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      </div></div>
      <div className="song-legend"><span className="local-color">● 本地已有 {tracks.filter((track) => track.local).length}</span><span className="missing-color">● 尚未下载 {tracks.filter((track) => !track.local).length}</span><span>勾选参与同步；拖拽可调整新增、删除和留存</span></div>
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
        <EditorTrackList tracks={groups[lane.action]} enabled={editor.enabled} selectTracks={selectTracks} action={lane.action} blocked={blocked} move={move} playlistId={item.id} />
      </section>)}</div>
      <p className="editor-status" role="status">{dirty ? `${changed.length} 首歌曲的选择尚未保存` : message || '未勾选的歌曲不下载、不删除。撤回用于尚未同步的方案。'}</p>
      {syncDisabled && <p className="editor-notice">在左侧勾选这个歌单后可同步。</p>}
      <div className="modal-actions"><button onClick={finish}>返回歌单</button><button disabled={blocked || !dirty} onClick={persist}>保存方案</button>
        <button className="primary" disabled={blocked || syncDisabled} onClick={async () => { if (await persist()) { const result = await sync(); if (result) close(); } }}>同步当前歌单</button>
      </div>
    </div>
  </Dialog>;
}

function EditorTrackList({ tracks, enabled, selectTracks, action, blocked, move, playlistId }) {
  const [page, setPage] = useState(0);
  const pageSize = 100;
  const count = Math.max(1, Math.ceil(tracks.length / pageSize));
  const current = Math.min(page, count - 1);
  return <div className="editor-track-frame"><div className="editor-track-list">
    {tracks.slice(current * pageSize, (current + 1) * pageSize).map((track) => <div className={`editor-track ${track.local ? 'is-local' : 'is-missing'} ${enabled[track.id] ? '' : 'is-excluded'}`} key={track.id}
      draggable={!blocked} data-track-id={track.id}
      onDragStart={(event) => { event.dataTransfer.setData(dragType, JSON.stringify({ id: track.id, playlistId })); event.dataTransfer.effectAllowed = 'move'; }}>
      <input type="checkbox" className="selection-checkbox" aria-label={`同步歌曲：${track.name}`} checked={Boolean(enabled[track.id])} disabled={blocked}
        draggable={false} onMouseDown={(event) => event.stopPropagation()} onChange={(event) => selectTracks([track], event.target.checked)} />
      <div className="editor-track-info"><strong title={track.name}>{track.name}</strong><span title={(track.artists || []).join(', ')}>{(track.artists || []).join(', ') || '未知艺术家'}</span>
      <small>{track.local ? track.remoteRemoved ? '本地已有 · 在线已移除' : '本地已有' : '尚未下载'}{!enabled[track.id] && ' · 不同步'}</small></div>
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
      <label>本地文件夹<div className="mapping-path"><input aria-label="映射的本地文件夹" placeholder="选择音乐库根文件夹或现有子文件夹" value={folder} onChange={(event) => { setFolder(event.target.value); setError(''); }} /><button type="button" disabled={busy} onClick={() => browse(folder || data.rootPath, setFolder, setError)}>浏览…</button></div></label>
      <button className="use-library-folder" type="button" disabled={busy || data.scanning || data.task.active} onClick={() => { setFolder(data.rootPath); setError(''); }}>使用音乐库文件夹</button>
      <p className="mapping-root">音乐库：{data.rootPath}</p>
      <p className="hint">可选择音乐库根文件夹或现有子文件夹。根目录映射只处理直接位于根目录的歌曲，子文件夹保持独立；移除根目录映射会保留全部文件。</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy || data.scanning || data.task.active || !id || !folder}>保存映射</button></div>
    </form>
  </Dialog>;
}
