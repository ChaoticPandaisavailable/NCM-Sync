import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPlanHistory, planHistory } from './plan-history.mjs';

const dragType = 'application/x-ncmsync-track';
const duration = (value) => `${Math.floor((value || 0) / 60000)}:${String(Math.floor(((value || 0) % 60000) / 1000)).padStart(2, '0')}`;

export function PlaylistEditor({ item, blocked, syncDisabled, close, save, sync, Dialog }) {
  const tracks = useMemo(() => [...item.added, ...item.removed, ...item.existing], [item]);
  const online = item.onlineTracks;
  const local = item.localTracks;
  const initial = useMemo(() => Object.fromEntries(tracks.map((track) => [track.id, track.action])), [tracks]);
  const initialEnabled = useMemo(() => Object.fromEntries(tracks.map((track) => [track.id, track.syncSelected])), [tracks]);
  const [editor, dispatch] = useReducer(planHistory, null, () => createPlanHistory(initial, initialEnabled));
  const [saved, setSaved] = useState({ targets: initial, enabled: initialEnabled });
  const [revision, setRevision] = useState(item.revision);
  const [dragOver, setDragOver] = useState('');
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const container = useRef(null);
  useEffect(() => { container.current?.focus(); }, []);
  const changed = Object.keys(editor.targets).filter((id) => editor.targets[id] !== saved.targets[id] || editor.enabled[id] !== saved.enabled[id]);
  const selected = (id) => Boolean(editor.enabled[id]) && editor.targets[id] !== 'remove';
  const selectedCount = tracks.filter((track) => selected(track.id)).length;
  const downloadCount = tracks.filter((track) => !track.local && selected(track.id) && editor.targets[track.id] === 'add').length;
  const removeCount = tracks.filter((track) => track.local && editor.enabled[track.id] && editor.targets[track.id] === 'remove').length;
  const dirty = changed.length > 0;
  const selectTracks = (items, enabled) => {
    if (blocked) return;
    dispatch({ type: 'batch', changes: items.map((track) => ({ id: track.id, enabled,
      to: enabled ? track.local ? 'keep' : 'add' : 'keep' })) });
    setMessage('');
  };
  const remove = (track) => {
    if (blocked) return;
    dispatch({ type: 'move', id: track.id, to: editor.targets[track.id] === 'remove' ? 'keep' : 'remove', enabled: true });
    setMessage('');
  };
  const finish = () => { if (!dirty || window.confirm('放弃尚未应用的歌曲选择？')) close(); };
  async function persist() {
    const result = await save(revision, tracks.map((track) => ({ id: track.id, action: editor.targets[track.id], enabled: Boolean(editor.enabled[track.id]) })));
    if (!result) return false;
    setRevision(result.revision);
    setSaved({ targets: editor.targets, enabled: editor.enabled });
    setMessage('方案已应用，勾选和未勾选的状态均已保存。');
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
  const filter = (items) => items.filter((track) => `${track.name} ${(track.artists || []).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  function drop(event, side) {
    event.preventDefault(); setDragOver('');
    try {
      const payload = JSON.parse(event.dataTransfer.getData(dragType));
      const track = tracks.find((entry) => entry.id === payload.id);
      if (track && payload.playlistId === item.id && payload.side !== side) selectTracks([track], side === 'local');
    } catch { /* Ignore unrelated drag data. */ }
  }
  return <Dialog title={item.displayName} subtitle={item.folderPath} close={finish} extraWide>
    <div className="playlist-editor comparison-editor" ref={container} tabIndex={-1} onKeyDown={keyboard}>
      <div className="comparison-toolbar">
        <CheckAll items={tracks} selected={selected} disabled={blocked} change={selectTracks} label="全选全部歌曲" />
        <span className="comparison-totals">已选 {selectedCount} / {tracks.length} · 待下载 {downloadCount} · 待删除 {removeCount}</span>
        <label className="comparison-search"><input aria-label="搜索歌单歌曲" placeholder="搜索歌曲或歌手" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button disabled={blocked || !editor.past.length} onClick={() => dispatch({ type: 'undo' })} title="Ctrl+Z">撤回</button>
        <button disabled={blocked || !editor.future.length} onClick={() => dispatch({ type: 'redo' })} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      </div>
      <div className="comparison-legend"><span className="local-swatch">本地已有</span><span className="missing-swatch">尚未下载</span><span>取消勾选会保持歌曲原样；删除需单独选择</span></div>
      {blocked && <p className="comparison-notice" role="status">扫描或同步进行中，结束后可编辑。</p>}
      <div className="song-comparison">{[{ side: 'online', title: '在线歌单', items: online }, { side: 'local', title: '本地已有', items: local }].map(({ side, title, items }) => <section key={side}
        data-testid={`songs-${side}`} className={`comparison-column ${dragOver === side ? 'drag-over' : ''}`}
        onDragOver={(event) => { if (!blocked && event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(side); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(''); }} onDrop={(event) => drop(event, side)}>
        <header><h4>{title} <b>{items.length}</b></h4><CheckAll items={items} selected={selected} disabled={blocked} change={selectTracks} label={`全选${title}歌曲`} /></header>
        <ComparisonList tracks={filter(items)} side={side} selected={selected} targets={editor.targets} enabled={editor.enabled} blocked={blocked} selectTracks={selectTracks} remove={remove} playlistId={item.id} />
      </section>)}</div>
      <footer className="comparison-footer"><div className="comparison-status" role="status">{dirty ? `${changed.length} 首歌曲的选择待应用` : message || '应用后保存完整方案，扫描和重启后继续保留。'}
        {syncDisabled && <small>此歌单未启用同步；可以先应用方案。</small>}</div>
        <button onClick={finish}>返回</button><button disabled={blocked || syncDisabled} onClick={async () => { if (await persist()) { const result = await sync(); if (result) close(); } }}>应用并同步</button>
        <button className="primary" disabled={blocked} onClick={persist}>应用方案</button>
      </footer>
    </div>
  </Dialog>;
}

function CheckAll({ items, selected, disabled, change, label }) {
  const input = useRef(null);
  const count = items.filter((track) => selected(track.id)).length;
  useEffect(() => { if (input.current) input.current.indeterminate = count > 0 && count < items.length; }, [count, items.length]);
  return <label className="comparison-all"><input ref={input} className="selection-checkbox" type="checkbox" aria-label={label} checked={items.length > 0 && count === items.length} disabled={disabled || !items.length} onChange={(event) => change(items, event.target.checked)} /><span>全选</span></label>;
}

function ComparisonList({ tracks, side, selected, targets, enabled, blocked, selectTracks, remove, playlistId }) {
  const [page, setPage] = useState(0);
  const pageSize = 100;
  const count = Math.max(1, Math.ceil(tracks.length / pageSize));
  const current = Math.min(page, count - 1);
  useEffect(() => setPage(0), [tracks.length, tracks[0]?.id]);
  return <div className="comparison-list-frame"><div className={`comparison-list-labels ${side}`} aria-hidden="true"><span /><span>#</span><span>歌曲</span><span>歌手</span><span>时长</span><span>{side === 'online' ? '状态' : '操作'}</span></div>
    <div className="comparison-song-list">{tracks.slice(current * pageSize, (current + 1) * pageSize).map((track, index) => {
      const deleting = track.local && targets[track.id] === 'remove' && enabled[track.id];
      const state = deleting ? '待删除' : track.local ? selected(track.id) ? '本地已有' : '已有 · 未选' : selected(track.id) ? '待下载' : '缺少 · 未选';
      return <div className={`comparison-song-row ${side} ${track.local ? 'is-local' : 'is-missing'} ${deleting ? 'scheduled-removal' : ''}`} key={track.id}
        draggable={!blocked} data-track-id={track.id} data-selected={selected(track.id)}
        onDragStart={(event) => { if (event.target.closest('input,button')) return event.preventDefault(); event.dataTransfer.setData(dragType, JSON.stringify({ id: track.id, playlistId, side })); event.dataTransfer.effectAllowed = 'move'; }}>
        <input type="checkbox" className="selection-checkbox" aria-label={`${side === 'online' ? '在线歌曲' : '已有歌曲'}：${track.name}`} checked={selected(track.id)} disabled={blocked} draggable={false} onMouseDown={(event) => event.stopPropagation()} onChange={(event) => selectTracks([track], event.target.checked)} />
        <span className="comparison-song-number">{current * pageSize + index + 1}</span><strong title={`${track.name}${track.remoteRemoved ? ' · 在线已移除' : ''}`}>{track.name}</strong>
        <span className="comparison-song-artist" title={(track.artists || []).join(', ')}>{(track.artists || []).join(', ') || '未知艺术家'}</span><small className="comparison-song-duration">{duration(track.duration)}</small>
        {side === 'online' ? <small className="comparison-song-state">{state}</small> : <button className="comparison-remove" disabled={blocked} aria-label={`${track.name}：${deleting ? '留存' : '删除'}`} onClick={() => remove(track)}>{deleting ? '留存' : '删除'}</button>}
      </div>;
    })}{!tracks.length && <p className="empty-state">{side === 'online' ? '没有匹配的在线歌曲' : '本地暂无匹配歌曲'}</p>}</div>
    {count > 1 && <nav className="track-pagination" aria-label={`${side === 'online' ? '在线' : '已有'}歌曲分页`}><button disabled={!current} onClick={() => setPage(current - 1)}>上一页</button><span>{current + 1} / {count} · {tracks.length} 首</span><button disabled={current === count - 1} onClick={() => setPage(current + 1)}>下一页</button></nav>}
  </div>;
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
