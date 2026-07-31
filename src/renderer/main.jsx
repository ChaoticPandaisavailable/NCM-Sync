import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import { sortRows } from './sorting.mjs';
import './styles.css';
import logoUrl from '../../assets/ncmsync-logo-256.png';

const date = (value) => value ? new Date(Number(value)).toLocaleDateString('zh-CN') : '—';
const dateTime = (value) => {
  if (!value) return '从未';
  const current = new Date(Number(value));
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(current.getFullYear() % 100)}/${pad(current.getMonth() + 1)}/${pad(current.getDate())} ${pad(current.getHours())}:${pad(current.getMinutes())}`;
};
const duration = (value) => `${Math.floor((value || 0) / 60000)}:${String(Math.floor(((value || 0) % 60000) / 1000)).padStart(2, '0')}`;

function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState(null);
  const [onlineTab, setOnlineTab] = useState('created');
  const [onlineSearch, setOnlineSearch] = useState('');
  const [localSearch, setLocalSearch] = useState('');
  const [onlineSelected, setOnlineSelected] = useState(new Set());
  const [localSelected, setLocalSelected] = useState(new Set());
  const [onlineSort, setOnlineSort] = useState({ key: 'createdAt', direction: -1 });
  const [localSort, setLocalSort] = useState({ key: 'createdAt', direction: -1 });
  const [modal, setModal] = useState(null);
  const [context, setContext] = useState(null);
  const onlineAnchor = useRef(null);
  const localAnchor = useRef(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const next = await api.bootstrap();
      setData(next);
      if (!quiet && !next.initialized) setModal({ type: 'setup' });
    } catch (error) { notify(error.message, 'error'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!data) return undefined;
    const delay = data.task.active || data.scanning || data.settings.realtimeSync ? 500 : 1_200;
    const timer = setInterval(() => load(true), delay);
    return () => clearInterval(timer);
  }, [data?.task.active, data?.scanning, data?.settings.realtimeSync, load]);
  useEffect(() => {
    const close = () => setContext(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  function notify(message, type = 'success') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3800);
  }

  async function action(name, fn, success) {
    setBusy(name);
    try {
      const result = await fn();
      await load(true);
      if (success) notify(typeof success === 'function' ? success(result) : success);
      return result;
    } catch (error) { notify(error.message, 'error'); return null; }
    finally { setBusy(''); }
  }

  const onlineCounts = useMemo(() => ({
    created: (data?.online || []).filter((item) => item.kind === 'created').length,
    saved: (data?.online || []).filter((item) => item.kind === 'saved').length
  }), [data]);
  const onlineSelectedCounts = useMemo(() => ({
    created: (data?.online || []).filter((item) => item.kind === 'created' && onlineSelected.has(item.id)).length,
    saved: (data?.online || []).filter((item) => item.kind === 'saved' && onlineSelected.has(item.id)).length
  }), [data, onlineSelected]);
  const onlineRows = useMemo(() => sortRows((data?.online || [])
    .filter((item) => item.kind === onlineTab)
    .filter((item) => item.name.toLowerCase().includes(onlineSearch.toLowerCase())), onlineSort), [data, onlineTab, onlineSearch, onlineSort]);
  const localRows = useMemo(() => sortRows((data?.local || [])
    .filter((item) => item.displayName.toLowerCase().includes(localSearch.toLowerCase())), localSort), [data, localSearch, localSort]);

  function toggleSelection(event, item, rows, selected, setSelected, anchorRef) {
    const next = new Set(event.ctrlKey ? selected : []);
    if (event.shiftKey && anchorRef.current) {
      const from = rows.findIndex((row) => row.id === anchorRef.current);
      const to = rows.findIndex((row) => row.id === item.id);
      for (const row of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(row.id);
    } else if (event.ctrlKey && next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    anchorRef.current = item.id;
    setSelected(next);
  }

  function tableKeyDown(event, rows, setSelected) {
    if (event.ctrlKey && event.key.toLowerCase() === 'a') {
      event.preventDefault(); setSelected(new Set(rows.map((row) => row.id)));
    }
  }

  async function showOnlineDetail(item) {
    setModal({ type: 'loading', title: item.name });
    const detail = await action('detail', () => api.detail(item.id));
    if (detail) setModal({ type: 'tracks', title: item.name, tracks: detail.tracks }); else setModal(null);
  }

  function showLocalDetail(item) { setModal({ type: 'changes', itemId: item.id }); }

  async function setupUser({ userId, libraryPath }, later = false) {
    if (libraryPath && libraryPath !== data.rootPath) {
      const changed = await action('library', () => api.changeLibrary(libraryPath, false, true), '音乐库位置已设置');
      if (!changed) return;
    }
    if (later) {
      await action('setup', api.setupLater, null);
      setModal(null); return;
    }
    const result = await action('setup', () => api.setup(userId), '用户与歌单加载完成');
    if (result) { setData(result); setModal(null); }
  }

  async function scan() { await action('scan', api.scan, '扫描更新完成'); }
  async function addSelected() {
    if (!onlineSelected.size) return;
    const result = await action('add', () => api.addLocal([...onlineSelected]), `已添加 ${onlineSelected.size} 个歌单`);
    if (result) setOnlineSelected(new Set());
  }
  async function sync(ids) { await action('sync', () => api.sync(ids), '同步任务已开始'); }
  async function toggleRealtime(enabled) { await action('realtime', () => api.saveSettings({ realtimeSync: enabled }), enabled ? '实时同步已开启' : '实时同步已关闭'); }
  async function pauseSelected() {
    const rows = (data.local || []).filter((row) => localSelected.has(row.id));
    const shouldPause = !rows.every((row) => row.paused);
    await action('pause-local', () => api.pauseLocal([...localSelected], shouldPause), shouldPause ? '歌单已暂停' : '歌单已恢复');
  }
  function confirmRemove(ids = [...localSelected]) {
    const remove = async (dontAsk = false) => {
      if (dontAsk) await api.saveSettings({ removeLocalDontAsk: true, scanHours: data.settings.scanHours, scanMinutes: data.settings.scanMinutes });
        await action('remove', () => api.removeLocal(ids), '本地歌单已移除');
        setLocalSelected(new Set()); setModal(null);
    };
    if (data.settings.removeLocalDontAsk) { remove(); return; }
    setModal({ type: 'confirm', title: '删除本地歌单', dangerous: true, showDontAsk: true,
      message: '“删除本地歌单”会删除所选歌单文件夹及其中的所有文件。如果想保留本地文件，请使用“暂停同步”。',
      confirmText: '删除本地歌单', onConfirm: remove });
  }
  function confirmCancel() {
    if (data.settings.cancelDontAsk) action('cancel', () => api.cancelTask(data.settings.cancelDeleteDownloaded), '同步任务已取消');
    else setModal({ type: 'cancel-task' });
  }
  function openContext(event, item) {
    event.preventDefault();
    if (!localSelected.has(item.id)) setLocalSelected(new Set([item.id]));
    setContext({ x: event.clientX, y: event.clientY, item });
  }

  if (loading || !data) return <div className="loading-screen"><Logo /><span>正在启动本地同步服务…</span></div>;
  const selectedLocalRows = data.local.filter((row) => localSelected.has(row.id));
  const selectedAllPaused = selectedLocalRows.length && selectedLocalRows.every((row) => row.paused);
  const hasUnsynced = data.local.some((row) => !row.paused && !row.offline && (row.added.length || row.removed.length));
  const progress = taskPercent(data.task);

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><Logo /><div><strong>NCM Sync</strong><span>网易云音乐本地同步工具</span></div></div>
      <GlobalStatus data={data} />
      <button className="scan-button" disabled={busy || data.scanning || data.task.active} onClick={scan} title="扫描在线与本地歌单更新"><span>↻</span>扫描更新</button>
      <button className="icon-button" aria-label="设置" title="设置" onClick={() => setModal({ type: 'settings' })}>⚙</button>
      <WindowControls />
    </header>

    <main className="workspace">
      <section className="pane online-pane">
        <PaneHeading eyebrow="ONLINE" title="在线歌单" count={data.online.length} />
        <Search value={onlineSearch} onChange={setOnlineSearch} placeholder={`在 ${onlineTab === 'created' ? '创建的歌单' : '收藏的歌单'} 中搜索`} />
        <div className="tabs">
          {['created','saved'].map((tab) => <button key={tab} className={onlineTab === tab ? 'active' : ''} onClick={() => setOnlineTab(tab)}>
            <span>{tab === 'created' ? '创建的歌单' : '收藏的歌单'} <b>{onlineCounts[tab]}</b></span><small className={`tab-selection-count ${onlineTab === tab ? '' : 'inactive'}`} aria-hidden={onlineTab !== tab}>已选：{onlineSelectedCounts[tab]}</small>
          </button>)}
        </div>
        <div className="table-wrap" tabIndex="0" onKeyDown={(event) => tableKeyDown(event, onlineRows, setOnlineSelected)}>
          <table><thead><tr>
            <Sortable label="名称" sort={onlineSort} field="name" setSort={setOnlineSort} />
            <Sortable label="歌曲数" sort={onlineSort} field="trackCount" setSort={setOnlineSort} />
            <Sortable label="创建日期" sort={onlineSort} field="createdAt" setSort={setOnlineSort} />
          </tr></thead><tbody>
            {onlineRows.map((item) => <tr key={item.id} className={onlineSelected.has(item.id) ? 'selected' : ''}
              onClick={(event) => toggleSelection(event, item, onlineRows, onlineSelected, setOnlineSelected, onlineAnchor)} onDoubleClick={() => showOnlineDetail(item)}>
              <td><div className="name-cell"><span>{item.name}</span></div></td><td>{item.trackCount}</td><td>{date(item.createdAt)}</td>
            </tr>)}
            {!onlineRows.length && <EmptyRow columns={3} text={data.settings.userId ? '没有匹配的在线歌单' : '请先在设置中填写用户 ID'} />}
          </tbody></table>
        </div>
        <button className="primary wide" disabled={!onlineSelected.size || busy || data.scanning} onClick={addSelected}>＋ 添加到本地歌单 <kbd>{onlineSelected.size || ''}</kbd></button>
      </section>

      <section className="sync-rail">
        <div className="rail-line" />
        <label className="realtime-switch" title="持续检测所有未暂停歌单，发现更新后立即下载"><span>实时同步</span><input aria-label="实时同步" type="checkbox" checked={Boolean(data.settings.realtimeSync)} disabled={busy === 'realtime'} onChange={(event) => toggleRealtime(event.target.checked)} /><i /></label>
        <div className={`sync-progress-ring ${data.task.active ? 'active' : ''} ${data.settings.realtimeSync && !data.task.active ? 'realtime' : ''}`}>
          <svg className="progress-ring" viewBox="0 0 120 120" aria-hidden="true"><circle className="progress-ring-track" cx="60" cy="60" r="56" pathLength="100" /><circle className="progress-ring-value" cx="60" cy="60" r="56" pathLength="100" style={{ strokeDashoffset: 100 - progress }} /></svg>
          <button className="sync-button" disabled={busy || data.task.active || data.scanning || !data.local.length} onClick={() => sync()}>
            <span>⇄</span><strong>{data.settings.realtimeSync ? '实时同步中' : '一键同步'}</strong><small>{data.task.active ? `${Math.round(progress)}%` : data.settings.realtimeSync ? '持续监测歌单更新' : hasUnsynced ? '有更新待处理' : '检查并同步全部'}</small>
          </button>
        </div>
        <div className="rail-task-controls">
          <button disabled={!data.task.active} onClick={() => action('task', data.task.paused ? api.resumeTask : api.pauseTask, data.task.paused ? '任务已继续' : '任务已暂停')}>{data.task.paused ? '▶ 继续任务' : 'Ⅱ 暂停任务'}</button>
          <button disabled={!data.task.active} onClick={confirmCancel}>× 取消任务</button>
        </div>
        <div className="rail-line" />
      </section>

      <section className="pane local-pane">
        <PaneHeading eyebrow="LOCAL" title="本地歌单" count={data.local.length} action={<div className="library-location"><span>音乐库位置</span><code title={data.rootPath}>{data.rootPath}</code><button onClick={() => action('open-library', api.openLibrary)}>打开文件夹</button></div>} />
        <Search value={localSearch} onChange={setLocalSearch} placeholder="搜索本地歌单" />
        <div className="table-wrap" tabIndex="0" onKeyDown={(event) => tableKeyDown(event, localRows, setLocalSelected)}>
          <table><thead><tr>
            <Sortable label="状态" sort={localSort} field="status" setSort={setLocalSort} className="status-col" />
            <Sortable label="名称" sort={localSort} field="displayName" setSort={setLocalSort} />
            <Sortable label="歌曲数" sort={localSort} field="trackCount" setSort={setLocalSort} />
            <Sortable label="更新" sort={localSort} field="updateCount" setSort={setLocalSort} />
            <Sortable label="创建日期" sort={localSort} field="createdAt" setSort={setLocalSort} />
          </tr></thead><tbody>
            {localRows.map((item) => <tr key={item.id} className={localSelected.has(item.id) ? 'selected' : ''}
              onClick={(event) => toggleSelection(event, item, localRows, localSelected, setLocalSelected, localAnchor)} onDoubleClick={() => showLocalDetail(item)} onContextMenu={(event) => openContext(event, item)}>
              <td><StatusBadge status={item.status} /></td>
              <td><div className="local-name"><strong>{item.displayName}</strong>{item.pendingName && <button className="rename-hint" onClick={(event) => { event.stopPropagation(); action('rename', () => api.renameFolder(item.id), '文件夹已同步重命名'); }}>同步文件夹名称</button>}{item.syncProgress && <small>{item.syncProgress}</small>}</div></td>
              <td>{item.trackCount}</td><td><ChangeBadges item={item} /></td><td>{date(item.createdAt)}</td>
            </tr>)}
            {!localRows.length && <EmptyRow columns={5} text="还没有本地歌单，从左侧选择后添加" />}
          </tbody></table>
        </div>
        <div className="pane-actions">
          <button disabled={!localSelected.size || busy || data.task.active} onClick={pauseSelected}>{selectedAllPaused ? '▶ 恢复同步' : 'Ⅱ 暂停同步'}</button>
          <button className="danger-ghost" disabled={!localSelected.size || busy} onClick={() => confirmRemove()}>− 删除本地歌单</button>
        </div>
      </section>
    </main>

    {context && <ContextMenu {...context} data={data} onClose={() => setContext(null)} onDetail={showLocalDetail} onSync={(item) => sync([item.id])} onPause={(item) => action('pause-local', () => api.pauseLocal([item.id], !item.paused), item.paused ? '歌单已恢复' : '歌单已暂停')} onRemove={(item) => confirmRemove([item.id])} onRedirect={(item) => setModal({ type: 'redirect', item })} onOpen={(item) => action('open', () => api.openFolder(item.id))} />}
    {modal && <ModalRouter modal={modal} data={data} busy={busy} close={() => modal.type !== 'setup' && setModal(null)} setupUser={setupUser} action={action} />}
    {toast && <div className={`toast ${toast.type}`}>{toast.type === 'error' ? '!' : '✓'} {toast.message}</div>}
  </div>;
}

function GlobalStatus({ data }) {
  return <div className={`global-status ${data.task.error ? 'error' : ''}`}>
    <div className="status-current"><span className={`pulse ${data.task.active || data.scanning || data.settings.realtimeSync ? 'active' : ''}`} /><strong>{statusText(data)}</strong></div>
    <div className="status-times"><span>上次扫描 <b>{dateTime(data.lastScanAt)}</b></span><span>上次同步 <b>{dateTime(data.lastSyncAt)}</b></span></div>
  </div>;
}
function Logo() { return <img className="logo" src={logoUrl} alt="NCM Sync" />; }
function PaneHeading({ eyebrow, title, count, action }) { return <div className="pane-heading"><small>{eyebrow}</small><div className="pane-heading-line"><h2>{title}<b>{count}</b></h2>{action}</div></div>; }
function WindowControls() { return <div className="window-controls" aria-label="窗口操作">
  <button className="window-minimize" aria-label="最小化" title="最小化" onClick={() => window.cloudMusicDesktop?.minimizeWindow()}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5h8" /></svg></button>
  <button className="window-maximize" aria-label="最大化或还原" title="最大化或还原" onClick={() => window.cloudMusicDesktop?.toggleMaximizeWindow()}><svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.25" y="2.25" width="7.5" height="7.5" rx=".4" /></svg></button>
  <button className="window-close" aria-label="退出应用" title="关闭" onClick={() => window.cloudMusicDesktop?.closeWindow()}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg></button>
</div>; }
function Search({ value, onChange, placeholder }) { return <label className="search"><span>⌕</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }
function Sortable({ label, sort, field, setSort, className = '' }) { return <th className={className} onClick={() => setSort((old) => ({ key: field, direction: old.key === field ? -old.direction : 1 }))}>{label}{sort.key === field && <span className="sort">{sort.direction > 0 ? '↑' : '↓'}</span>}</th>; }
function EmptyRow({ columns, text }) { return <tr className="empty-row"><td colSpan={columns}><span>◎</span>{text}</td></tr>; }
function StatusBadge({ status }) { return <span className={`status-badge ${status}`}>{{synced:'同步',pending:'更新',paused:'暂停',offline:'离线'}[status]}</span>; }
function ChangeBadges({ item }) { return <div className={`badges ${item.paused ? 'muted' : ''}`}>{item.added.length > 0 && <span className="plus">+{item.added.length}</span>}{item.removed.length > 0 && <span className="minus">−{item.removed.length}</span>}{!item.added.length && !item.removed.length && <span>—</span>}</div>; }

function ContextMenu({ x, y, item, data, onClose, onDetail, onSync, onPause, onRemove, onRedirect, onOpen }) {
  const syncDisabled = item.paused || item.offline || data.scanning || data.task.active;
  const click = (fn) => () => { onClose(); fn(item); };
  return <div className="context-menu" style={{ left: Math.min(x, innerWidth - 230), top: Math.min(y, innerHeight - 300) }} onClick={(event) => event.stopPropagation()}>
    <button onClick={click(onOpen)}>▣ 打开文件夹</button><button onClick={click(onDetail)}>≡ 查看更新详情</button>
    <button disabled={syncDisabled} onClick={click(onSync)}>⇄ 同步当前歌单</button><hr />
    {item.offline && <button onClick={click(onRedirect)}>↪ 重定向到在线歌单</button>}
    <button disabled={data.task.active} onClick={click(onPause)}>{item.paused ? '▶ 恢复同步' : 'Ⅱ 暂停同步'}</button>
    <button className="danger" onClick={click(onRemove)}>− 删除本地歌单</button>
  </div>;
}

function ModalRouter({ modal, data, busy, close, setupUser, action }) {
  if (modal.type === 'setup') return <SetupModal data={data} busy={busy} onSubmit={setupUser} />;
  if (modal.type === 'settings') return <SettingsModal data={data} busy={busy} close={close} save={async (values) => {
    if (values.libraryPath !== data.rootPath) {
      const migrate = window.confirm('是否将音乐迁移到新位置？\n\n选择“确定”会迁移歌曲实体和本地歌单；选择“取消”会保留旧文件，但所有本地歌单需要重新同步下载。');
      const changed = await action('library', () => api.changeLibrary(values.libraryPath, migrate), (result) => result.scanStatus || (migrate ? '音乐库迁移完成' : '音乐库位置已更改'));
      if (!changed) return;
    }
    if (values.userId !== data.settings.userId) {
      if (data.local.length && !window.confirm('更换 ID 后，现有本地歌单将变为离线状态。是否继续？')) return;
      const result = await action('settings', () => api.setup(values.userId, true), '用户 ID 已更新');
      if (!result) return;
    }
    const result = await action('settings', () => api.saveSettings(values), '设置已保存');
    if (result) close();
  }} />;
  if (modal.type === 'tracks') return <TracksModal title={modal.title} tracks={modal.tracks} close={close} />;
  if (modal.type === 'changes') {
    const item = data.local.find((entry) => entry.id === modal.itemId);
    return item ? <ChangesModal item={item} settings={data.settings} close={close} saveDelete={(checked) => action('setting-delete', () => api.saveSettings({ deleteRemoved: checked, scanHours: data.settings.scanHours, scanMinutes: data.settings.scanMinutes }), '删除策略已更新')} /> : null;
  }
  if (modal.type === 'loading') return <Dialog title={modal.title} close={close}><div className="modal-loading"><span className="spinner" />正在读取歌单曲目…</div></Dialog>;
  if (modal.type === 'confirm') return <ConfirmDialog {...modal} busy={busy} close={close} />;
  if (modal.type === 'cancel-task') return <CancelTaskModal data={data} busy={busy} close={close} cancel={async (remove, dontAsk) => {
    await action('cancel', () => api.cancelTask(remove), '同步任务已取消');
    if (dontAsk) await api.saveSettings({ cancelDeleteDownloaded: remove, cancelDontAsk: true, scanHours: data.settings.scanHours, scanMinutes: data.settings.scanMinutes });
    close();
  }} />;
  if (modal.type === 'redirect') return <RedirectModal item={modal.item} online={data.online} busy={busy} close={close} submit={async (onlineId) => {
    const result = await action('redirect', () => api.redirect(modal.item.id, onlineId), '歌单关联已重定向'); if (result) close();
  }} />;
  return null;
}

function Dialog({ title, subtitle, close, children, wide = false, extraWide = false }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close?.()}><section className={`dialog ${wide ? 'wide' : ''} ${extraWide ? 'extra-wide' : ''}`}><header><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{close && <button aria-label="关闭" onClick={close}>×</button>}</header>{children}</section></div>; }

async function browseLibrary(current, setValue, setError) {
  if (!window.cloudMusicDesktop?.browseLibrary) return setError?.('当前环境不支持目录选择');
  try { const selected = await window.cloudMusicDesktop.browseLibrary(current); if (selected) setValue(selected); }
  catch (error) { setError?.(error.message || '选择目录失败'); }
}

function SetupModal({ data, busy, onSubmit }) {
  const [id, setId] = useState('');
  const [libraryPath, setLibraryPath] = useState(data.rootPath);
  const [error, setError] = useState('');
  const [accountStatus, setAccountStatus] = useState('');
  const [gettingAccount, setGettingAccount] = useState(false);
  async function submit(event) { event.preventDefault(); setError(''); if (!/^\d+$/.test(id.trim())) return setError('用户 ID 只能包含数字'); await onSubmit({ userId: id.trim(), libraryPath }); }
  async function acquireAccount() {
    if (!window.cloudMusicDesktop?.acquireNeteaseAccount) return setError('当前环境不支持登录引导');
    setError(''); setGettingAccount(true); setAccountStatus('请在新窗口中登录网易云音乐…');
    try {
      const result = await window.cloudMusicDesktop.acquireNeteaseAccount();
      if (result.acquired) { setId(result.userId); setAccountStatus(`已获取${result.nickname ? `“${result.nickname}”` : '当前账号'}的 ID 和 Cookie`); }
      else setAccountStatus('已取消，未更改账号信息');
    } catch (accountError) { setError(accountError.message || '获取账号信息失败'); setAccountStatus(''); }
    finally { setGettingAccount(false); }
  }
  return <Dialog title="连接你的网易云音乐" subtitle="首次设置 · 公开歌单无需登录即可读取"><form className="form" onSubmit={submit}>
    <label>网易云用户 ID<div className="input-action-row"><input autoFocus data-testid="setup-user-id" value={id} onChange={(event) => setId(event.target.value)} placeholder="请输入网易云用户 ID" /><button className="account-action" type="button" disabled={gettingAccount || busy} onClick={acquireAccount}>{gettingAccount ? '等待登录…' : '一键获取 ID 和 Cookie'}</button></div></label>
    {accountStatus && <small className="account-status">{accountStatus}</small>}
    <label>音乐库位置<div className="input-action-row"><input data-testid="setup-library-path" value={libraryPath} onChange={(event) => setLibraryPath(event.target.value)} placeholder="选择用于存放歌曲的文件夹" /><button type="button" className="account-action" onClick={() => browseLibrary(libraryPath, setLibraryPath, setError)}>浏览</button></div></label>
    {error && <div className="field-error">{error}</div>}
    <div className="modal-actions"><button type="button" onClick={() => onSubmit({ userId: '', libraryPath }, true)}>稍后设置</button><button className="primary" disabled={busy} type="submit">{busy ? '正在验证…' : '验证并继续'}</button></div>
  </form></Dialog>;
}

function SettingsModal({ data, busy, close, save }) {
  const [form, setForm] = useState({ ...data.settings, libraryPath: data.rootPath });
  const [cookieStatus, setCookieStatus] = useState('');
  const [gettingAccount, setGettingAccount] = useState(false);
  const [showCookie, setShowCookie] = useState(false);
  const [readingCookie, setReadingCookie] = useState(false);
  const update = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  async function acquireAccount() {
    if (!window.cloudMusicDesktop?.acquireNeteaseAccount) return setCookieStatus('当前环境不支持登录引导，请手动填写账号信息');
    setGettingAccount(true); setCookieStatus('请在新窗口中登录网易云音乐…');
    try {
      const result = await window.cloudMusicDesktop.acquireNeteaseAccount();
      if (result.acquired) {
        setForm((old) => ({ ...old, userId: result.userId, cookie: '••••••••' })); setShowCookie(false);
        const account = result.nickname ? `“${result.nickname}”（ID ${result.userId}）` : `ID ${result.userId}`;
        setCookieStatus(result.resumed ? `已获取账号${account}和 Cookie，暂停的下载任务已自动继续` : result.retryRequired ? `已获取账号${account}和 Cookie；保存后重新同步` : `已获取账号${account}和 Cookie`);
      } else setCookieStatus('已取消，原账号信息未更改');
    } catch (error) { setCookieStatus(error.message || '获取账号信息失败'); }
    finally { setGettingAccount(false); }
  }
  async function toggleCookieVisibility() {
    if (showCookie) return setShowCookie(false);
    if (form.cookie === '••••••••') {
      if (!window.cloudMusicDesktop?.getSavedCookie) return setCookieStatus('当前环境不支持显示已保存的 Cookie');
      setReadingCookie(true);
      try { const result = await window.cloudMusicDesktop.getSavedCookie(); if (!result.cookie) return setCookieStatus('当前没有已保存的 Cookie'); update('cookie', result.cookie); }
      catch (error) { return setCookieStatus(error.message || '读取 Cookie 失败'); }
      finally { setReadingCookie(false); }
    }
    setShowCookie(true);
  }
  return <Dialog title="设置" close={close}><form className="form settings-form" onSubmit={(event) => { event.preventDefault(); save(form); }}>
    <label>音乐库位置<div className="input-action-row"><input value={form.libraryPath} onChange={(event) => update('libraryPath', event.target.value)} /><button type="button" className="account-action" onClick={() => browseLibrary(form.libraryPath, (value) => update('libraryPath', value), setCookieStatus)}>浏览</button></div></label>
    <label>用户 ID<div className="input-action-row"><input value={form.userId || ''} onChange={(event) => update('userId', event.target.value)} /><button data-testid="acquire-account" className="account-action" type="button" disabled={gettingAccount || busy} onClick={acquireAccount}>{gettingAccount ? '等待登录…' : '一键获取 ID 和 Cookie'}</button></div></label>
    <div className="cookie-setting"><span className="cookie-label">登录 Cookie（可选，用于受限音源）</span><div className="cookie-input-wrap"><input aria-label="登录 Cookie（可选，用于受限音源）" type={showCookie ? 'text' : 'password'} autoComplete="off" spellCheck="false" value={form.cookie || ''} onChange={(event) => update('cookie', event.target.value)} placeholder="MUSIC_U=...（仅保存在本机）" /><button className="cookie-visibility" type="button" aria-label={showCookie ? '隐藏 Cookie' : '显示 Cookie'} aria-pressed={showCookie} title={showCookie ? '隐藏 Cookie' : '显示 Cookie'} disabled={!form.cookie || readingCookie} onClick={toggleCookieVisibility}><EyeIcon visible={showCookie} /></button></div>{cookieStatus && <small className={/失败|不支持/.test(cookieStatus) ? 'cookie-status error' : 'cookie-status'}>{cookieStatus}</small>}<p className="hint">VIP/NCM 文件会在下载后由应用自动转换，无需配置外部工具。</p></div>
    <Toggle label="自动扫描" checked={form.autoScan} onChange={(value) => update('autoScan', value)} />
    <div className="inline-fields"><label>周期（小时）<input type="number" min="0" value={form.scanHours} onChange={(event) => update('scanHours', event.target.value)} /></label><label>分钟<input type="number" min="0" value={form.scanMinutes} onChange={(event) => update('scanMinutes', event.target.value)} /></label></div>
    <Toggle label="扫描到更新后自动同步" checked={form.autoSync} onChange={(value) => update('autoSync', value)} />
    <Toggle label="同步时删除在线歌单中已减少的歌曲" checked={form.deleteRemoved} onChange={(value) => update('deleteRemoved', value)} />
    <label>在线歌单改名时<select value={form.renamePolicy || 'ask'} onChange={(event) => update('renamePolicy', event.target.value)}><option value="ask">提示后手动同步文件夹名</option><option value="auto">自动同步本地文件夹名</option></select></label>
    <Toggle label="取消任务时删除本次下载内容" checked={form.cancelDeleteDownloaded} onChange={(value) => update('cancelDeleteDownloaded', value)} />
    <Toggle label="取消任务时不再询问" checked={form.cancelDontAsk} onChange={(value) => update('cancelDontAsk', value)} />
    <Toggle label="删除本地歌单时不再询问" checked={form.removeLocalDontAsk} onChange={(value) => update('removeLocalDontAsk', value)} />
    <div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy}>保存设置</button></div>
  </form></Dialog>;
}

function EyeIcon({ visible }) { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.8" />{visible && <path d="m4 4 16 16" />}</svg>; }
function Toggle({ label, checked, onChange }) { return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} /><i /></label>; }
function TrackList({ tracks, empty = '暂无歌曲', compact = false }) {
  const pageSize = compact ? 100 : 200;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(tracks.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  useEffect(() => setPage(0), [tracks.length, tracks[0]?.id]);
  const start = safePage * pageSize;
  const visible = tracks.slice(start, start + pageSize);
  return <div className="track-list-frame"><div className={`track-list ${compact ? 'compact' : ''}`}>{tracks.length ? visible.map((track, index) => <div key={track.id}><span>{String(start + index + 1).padStart(2, '0')}</span><strong>{track.name || `歌曲 ${track.id}`}</strong><em>{(track.artists || []).join(', ') || '未知艺术家'}</em><small>{duration(track.duration)}</small></div>) : <p className="empty-state">{empty}</p>}</div>{pageCount > 1 && <nav className="track-pagination" aria-label="曲目分页"><button disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button><span>{safePage + 1} / {pageCount} · {tracks.length} 首</span><button disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>下一页</button></nav>}</div>;
}
function TracksModal({ title, tracks, close }) { return <Dialog title={title} subtitle={`${tracks.length} 首歌曲`} close={close} wide><TrackList tracks={tracks} /></Dialog>; }
function ChangesModal({ item, settings, close, saveDelete }) {
  const [checked, setChecked] = useState(settings.deleteRemoved);
  const columns = [
    { key: 'added', title: '新增歌曲', count: `+${item.added.length}`, empty: '没有新增歌曲' },
    { key: 'removed', title: '减少歌曲', count: `−${item.removed.length}`, empty: '没有减少歌曲', danger: true },
    { key: 'existing', title: '本地已有', count: item.existing.length, empty: '尚无已同步歌曲' }
  ];
  return <Dialog title={item.displayName} subtitle="本地与在线歌单差异" close={close} extraWide><div className="changes-grid">{columns.map((column) => <section key={column.key}><h4>{column.title} <b className={column.danger ? 'red' : ''}>{column.count}</b></h4><TrackList tracks={item[column.key]} empty={column.empty} compact /></section>)}</div><label className="delete-check"><input type="checkbox" checked={checked} onChange={(event) => { setChecked(event.target.checked); saveDelete(event.target.checked); }} /> 同步时一并删除减少的歌曲</label></Dialog>;
}
function ConfirmDialog({ title, message, confirmText, dangerous, showDontAsk, onConfirm, busy, close }) { const [dontAsk, setDontAsk] = useState(false); return <Dialog title={title} close={close}><div className="confirm-content"><div className={dangerous ? 'warning-icon' : 'info-icon'}>!</div><p>{message}</p></div>{showDontAsk && <label className="delete-check"><input type="checkbox" checked={dontAsk} onChange={(event) => setDontAsk(event.target.checked)} /> 下次不再询问</label>}<div className="modal-actions"><button onClick={close}>取消</button><button className={dangerous ? 'danger-button' : 'primary'} disabled={busy} onClick={() => onConfirm(dontAsk)}>{confirmText || '确认'}</button></div></Dialog>; }
function CancelTaskModal({ data, busy, close, cancel }) { const [remove, setRemove] = useState(data.settings.cancelDeleteDownloaded); const [dontAsk, setDontAsk] = useState(false); return <Dialog title="取消当前同步任务" close={close}><p className="dialog-copy">是否删除本次任务中已经下载并链接到歌单的内容？</p><label className="choice"><input type="radio" checked={remove} onChange={() => setRemove(true)} /> 删除本次下载内容</label><label className="choice"><input type="radio" checked={!remove} onChange={() => setRemove(false)} /> 保留已下载内容</label><label className="delete-check"><input type="checkbox" checked={dontAsk} onChange={(event) => setDontAsk(event.target.checked)} /> 下次不再询问</label><div className="modal-actions"><button onClick={close}>继续同步</button><button className="danger-button" disabled={busy} onClick={() => cancel(remove, dontAsk)}>取消任务</button></div></Dialog>; }
function RedirectModal({ item, online, busy, close, submit }) {
  const [tab, setTab] = useState('created'); const [search, setSearch] = useState(''); const [id, setId] = useState('');
  const counts = { created: online.filter((row) => row.kind === 'created').length, saved: online.filter((row) => row.kind === 'saved').length };
  const rows = online.filter((row) => row.kind === tab && row.name.toLowerCase().includes(search.toLowerCase()));
  return <Dialog title="重定向到在线歌单" subtitle={`为“${item.displayName}”选择新的在线来源`} close={close} wide><div className="redirect-browser"><Search value={search} onChange={setSearch} placeholder={`在 ${tab === 'created' ? '创建的歌单' : '收藏的歌单'} 中搜索`} /><div className="tabs">{['created','saved'].map((value) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}><span>{value === 'created' ? '创建的歌单' : '收藏的歌单'} <b>{counts[value]}</b></span></button>)}</div><div className="redirect-list">{rows.map((row) => <button key={row.id} className={id === row.id ? 'selected' : ''} onClick={() => setId(row.id)}><span className="cover-placeholder">♫</span><strong>{row.name}</strong><small>{row.trackCount} 首 · {date(row.createdAt)}</small></button>)}{!rows.length && <p className="empty-state">没有匹配的在线歌单</p>}</div><p className="hint">现有本地文件和暂停状态都会保留，重定向后将重新计算差异。</p></div><div className="modal-actions"><button onClick={close}>取消</button><button className="primary" disabled={!id || busy} onClick={() => submit(id)}>确认重定向</button></div></Dialog>;
}

function taskPercent(task) { if (!task.total) return 0; const perPlaylist = 100 / task.total; const trackPart = task.downloadTotal ? task.downloaded / task.downloadTotal : 1; return Math.min(100, ((task.current - 1) + trackPart) * perPlaylist); }
function statusText(data) { if (!data.settings.userId) return '当前未设置用户 ID，请先设置后使用同步功能'; if (data.task.error) return data.task.error; if (data.task.active) { const source = data.task.source === 'realtime' ? '实时同步' : data.task.source === 'auto' ? '自动同步' : '正在同步'; return data.task.paused ? `${source}任务已暂停` : `${source} ${data.task.current}/${data.task.total} 个歌单 · ${data.task.downloaded}/${data.task.downloadTotal}（并行 ${data.task.activeDownloads || 0}/${data.task.concurrency || 1}）`; } if (data.scanning) return data.scanStatus || '正在扫描本地与在线歌单差异…'; if (/失败|取消|中断|请重新/.test(data.scanStatus)) return data.scanStatus; const pending = data.local.filter((row) => row.status === 'pending').length; if (pending) return `${pending} 个歌单有更新待同步`; if (data.settings.realtimeSync) return '实时同步正在监测所有未暂停歌单'; return data.lastScanAt || data.lastSyncAt ? '所有本地歌单已同步' : '等待首次扫描'; }

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
