import { useEffect, useMemo, useRef, useState } from 'react'
import DecryptTab from './components/DecryptTab'
import DecryptDatConTab from './components/DecryptDatConTab'
import SerialTab from './components/SerialTab'
import { IconDroneLogs, IconDecrypt, IconDatCon, IconSerial, IconDroneLarge } from './components/Icons'

const FTPTABS = [
  { id: 'logs',    label: 'Drone Logs',        Icon: IconDroneLogs },
  { id: 'decrypt', label: 'Drone Data Decrypt', Icon: IconDecrypt },
  { id: 'decrypt-datcon', label: 'DatCon Decrypt', Icon: IconDatCon },
  { id: 'serial',  label: 'Serial/USB',         Icon: IconSerial },
]

function App() {
  const [activeTab, setActiveTab] = useState('serial')
  const [appVersion, setAppVersion] = useState('')
  const [allDrives, setAllDrives] = useState([])
  const [lastUpdated, setLastUpdated] = useState(0)
  const [driveError, setDriveError] = useState('')
  const [ftpDir, setFtpDir] = useState('/')
  const [ftpEntries, setFtpEntries] = useState([])
  const [ftpError, setFtpError] = useState('')
  const [ftpLastUpdated, setFtpLastUpdated] = useState(0)
  const [ftpHost, setFtpHost] = useState('auto')
  const [ftpPort, setFtpPort] = useState(21)
  const ftpBusyRef = useRef(false)

  // Download-all listeners and state
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [downloadAllFiles, setDownloadAllFiles] = useState([])
  const [downloadFolder, setDownloadFolder] = useState('')
  const folderInputRef = useRef(null)

  const [downloads, setDownloads] = useState({})

  const anySingleDownloading = useMemo(() => {
    return Object.values(downloads || {}).some((d) => d?.status === 'downloading')
  }, [downloads])

  const ftpOpsLocked = downloadingAll || anySingleDownloading

  const parentFtpDir = useMemo(() => {
    const cur = String(ftpDir || '/')
    if (cur === '/' || cur.trim() === '') return '/'
    const parts = cur.split('/').filter(Boolean)
    parts.pop()
    return '/' + parts.join('/')
  }, [ftpDir])

  const droneDrives = useMemo(() => {
    const drives = Array.isArray(allDrives) ? allDrives : []
    return drives
      .map((d) => ({ ...d, mountpoints: d.mountpoints || [] }))
      .filter((d) => d.mountpoints.length > 0)
      .filter((d) => d.isUSB || d.isRemovable || d.isCard)
  }, [allDrives])

  const statusText = useMemo(() => {
    if (driveError) return driveError
    if (droneDrives.length === 0) return 'No drone detected'
    const mps = droneDrives.flatMap((d) => d.mountpoints.map((m) => m.path)).filter(Boolean)
    const unique = Array.from(new Set(mps))
    return unique.length > 0 ? `Drone mounted: ${unique.join(', ')}` : 'Drone detected'
  }, [droneDrives, driveError])

  const refresh = async () => {
    if (!window?.api?.listDrives) {
      setDriveError('Drive API unavailable')
      setAllDrives([])
      setLastUpdated(Date.now())
      return
    }
    try {
      const list = await window?.api?.listDrives?.()
      setAllDrives(Array.isArray(list) ? list : [])
      setDriveError('')
      setLastUpdated(Date.now())
    } catch (e) {
      setDriveError(e?.message || 'Failed to list drives')
      setAllDrives([])
      setLastUpdated(Date.now())
    }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const v = await window?.api?.getAppVersion?.()
        if (!cancelled && v) setAppVersion(String(v))
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let alive = true
    refresh()
    const t = setInterval(() => {
      if (!alive) return
      refresh()
    }, 1500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const refreshFtp = async (dir = ftpDir) => {
    // Avoid concurrent FTP sessions during any download; some drone FTP servers return 421 under load.
    if (ftpOpsLocked) return
    if (ftpBusyRef.current) return
    ftpBusyRef.current = true
    if (!window?.api?.ftpList) {
      setFtpError('FTP API unavailable')
      setFtpEntries([])
      setFtpLastUpdated(Date.now())
      ftpBusyRef.current = false
      return
    }
    try {
      const res = await window.api.ftpList(dir)
      const entries = Array.isArray(res?.entries) ? res.entries : []
      const sorted = [...entries].sort((a, b) => {
        const ad = a?.type === 'dir'
        const bd = b?.type === 'dir'
        if (ad !== bd) return ad ? -1 : 1
        return String(a?.name || '').localeCompare(String(b?.name || ''))
      })
      setFtpEntries(sorted)
      setFtpError('')
      setFtpDir(res?.dir || dir)
      if (res?.host) setFtpHost(String(res.host))
      if (res?.port) setFtpPort(Number(res.port))
      setFtpLastUpdated(Date.now())
      // clear any download errors for new listing
      setDownloads((d) => {
        const next = { ...d }
        Object.keys(next).forEach((k) => {
          if (next[k].status === 'error') delete next[k]
        })
        return next
      })
    } catch (e) {
      setFtpError(e?.message || 'Failed to list FTP')
      setFtpEntries([])
      setFtpLastUpdated(Date.now())
    } finally {
      ftpBusyRef.current = false
    }
  }

  useEffect(() => {
    if (!window?.api?.onFtpDownloadAllManifest) return undefined
    const removeManifest = window.api.onFtpDownloadAllManifest((data) => {
      const files = Array.isArray(data?.files) ? data.files.map((f) => ({ path: f.path, name: f.name, size: f.size, status: 'pending' })) : []
      setDownloadAllFiles(files)
      setDownloadingAll(true)
    })
    const removeProgress = window.api.onFtpDownloadAllFileProgress((d) => {
      setDownloadAllFiles((arr) => arr.map((f) => (f.path === d.remotePath ? { ...f, status: 'downloading', bytes: d.bytes } : f)))
    })
    const removeStarted = window.api.onFtpDownloadAllFileStarted((d) => {
      setDownloadAllFiles((arr) => arr.map((f) => (f.path === d.remotePath ? { ...f, status: 'downloading' } : f)))
    })
    const removeFileDone = window.api.onFtpDownloadAllFileDone((d) => {
      setDownloadAllFiles((arr) => arr.map((f) => (f.path === d.remotePath ? { ...f, status: 'done', localPath: d.localPath } : f)))
    })
    const removeFileErr = window.api.onFtpDownloadAllFileError((d) => {
      setDownloadAllFiles((arr) => arr.map((f) => (f.path === d.remotePath ? { ...f, status: 'error', message: d.message } : f)))
    })
    const removeDone = window.api.onFtpDownloadAllDone((d) => {
      setDownloadingAll(false)
    })
    const removeErr = window.api.onFtpDownloadAllError((d) => {
      setDownloadingAll(false)
    })
    return () => {
      try { removeManifest && removeManifest() } catch {}
      try { removeProgress && removeProgress() } catch {}
      try { removeStarted && removeStarted() } catch {}
      try { removeFileDone && removeFileDone() } catch {}
      try { removeFileErr && removeFileErr() } catch {}
      try { removeDone && removeDone() } catch {}
      try { removeErr && removeErr() } catch {}
    }
  }, [])

  const joinFtpPath = (baseDir, childName) => {
    const base = String(baseDir || '/').trim() || '/'
    const child = String(childName || '').replace(/^\/+/, '')
    if (!child) return base
    return base.endsWith('/') ? `${base}${child}` : `${base}/${child}`
  }

  const startDownloadFolder = async (remoteDir) => {
    setDownloadAllFiles([])
    setDownloadingAll(true)
    try {
      await window.api.ftpDownloadAll(remoteDir, downloadFolder || undefined)
    } catch {
      setDownloadingAll(false)
    }
  }


  const chooseFolder = async () => {
    // Try native dialog via IPC first; if not available or fails, fallback to HTML directory input
    if (window?.api?.chooseDownloadDir) {
      let picked = null
      try {
        picked = await window.api.chooseDownloadDir()
      } catch {
        picked = null
      }
      if (picked) {
        setDownloadFolder(picked)
        return
      }
    }
    // Fallback: trigger a hidden <input webkitdirectory> to pick a folder
    if (folderInputRef?.current) folderInputRef.current.click()
  }

  // FTP progress handlers
  useEffect(() => {
    if (!window?.api?.onFtpProgress) return undefined
    const removeProgress = window.api.onFtpProgress((data) => {
      const key = `${data.remotePath}`
      setDownloads((d) => ({ ...d, [key]: { ...(d?.[key] || {}), status: 'downloading', progress: data.info } }))
    })
    const removeDone = window.api.onFtpDone((data) => {
      const key = `${data.remotePath}`
      setDownloads((d) => ({ ...d, [key]: { status: 'done', path: data.localPath, downloadsDir: data.downloadsDir } }))
    })
    const removeError = window.api.onFtpError((data) => {
      const key = `${data.remotePath}`
      setDownloads((d) => ({ ...d, [key]: { status: 'error', message: data.message } }))
    })
    return () => {
      try { removeProgress && removeProgress() } catch {}
      try { removeDone && removeDone() } catch {}
      try { removeError && removeError() } catch {}
    }
  }, [])

  useEffect(() => {
    let alive = true
    if (activeTab !== 'logs') {
      return () => {
        alive = false
      }
    }
    if (droneDrives.length === 0) {
      setFtpError('')
      setFtpEntries([])
      return
    }

    refreshFtp(ftpDir)
    if (ftpOpsLocked) return
    const t = setInterval(() => {
      if (!alive) return
      if (ftpOpsLocked) return
      refreshFtp(ftpDir)
    }, 12000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [activeTab, droneDrives.length, ftpOpsLocked, ftpDir])

  return (
    <div className="appShell">
      {/* ── Left sidebar ── */}
      <nav className="sidebar">
        <div className="sidebarLogo">
          <IconDroneLarge size={30} color="#e0e0e0" />
        </div>
        {FTPTABS.map(t => (
          <button
            key={t.id}
            className={`sidebarTab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setActiveTab(t.id)}
            title={t.label}
          >
            <span className="sidebarTabIcon"><t.Icon size={18} /></span>
            <span className="sidebarTabLabel">{t.label}</span>
          </button>
        ))}
      </nav>

      {/* ── Right content ── */}
      <div className="appContent">

      {activeTab === 'serial' && <SerialTab />}

      {activeTab === 'decrypt' && <DecryptTab />}

      {activeTab === 'decrypt-datcon' && <DecryptDatConTab />}

      {activeTab === 'logs' && <div className="monitorShell">
      <input ref={folderInputRef} style={{ display: 'none' }} type="file" webkitdirectory="true" directory="true" mozdirectory="true" onChange={(ev) => {
        const files = ev?.target?.files || []
        if (!files.length) return

        // In Electron, file objects have a `path` property we can use
        const firstPath = files[0]?.path || files[0]?.webkitRelativePath || ''
        if (!firstPath) return

        // Derive directory from firstPath
        const parts = String(firstPath).split(/[/\\]/)
        parts.pop()
        const dir = parts.join('\\')
        if (dir) setDownloadFolder(dir)
      }} />
      <header className="monitorHeader">
        <div className="monitorTitle">Drone Logs</div>
        <div className="monitorHeaderRight">
          <div className="headerStats" aria-label="Status summary">
            <div className="headerStat">
              <span className="headerStatLabel">App</span>
              <span className="headerStatValue">{appVersion || '-'}</span>
            </div>
            <div className="headerStat">
              <span className="headerStatLabel">Updated</span>
              <span className="headerStatValue">{lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '-'}</span>
            </div>
            <div className="headerStat">
              <span className="headerStatLabel">Drives</span>
              <span className="headerStatValue">{droneDrives.length}</span>
            </div>
          </div>

          <div className="monitorActions">
            <button className="smallBtn" type="button" onClick={refresh}>
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="monitorMain">
        <div className={droneDrives.length > 0 && !driveError ? 'status ok' : 'status warn'}>{statusText}</div>

        <div className="table">
          <div className="tableHead">
            <div>Name</div>
            <div>Device</div>
            <div>Mountpoints</div>
            <div>Flags</div>
            <div>Size</div>
          </div>
          {(droneDrives.length ? droneDrives : []).map((d) => {
            const flags = [
              d.isUSB ? 'USB' : null,
              d.isRemovable ? 'Removable' : null,
              d.isCard ? 'Card' : null,
              d.isReadOnly ? 'ReadOnly' : null
            ]
              .filter(Boolean)
              .join(', ')
            const mps = (d.mountpoints || []).map((m) => m.path).filter(Boolean).join(' ')
            const mountpoints = d.mountpoints || []
            const bestMountpoint = mountpoints.find(
              (m) => typeof m?.totalBytes === 'number' && m.totalBytes > 0
            )
            const totalBytes =
              typeof bestMountpoint?.totalBytes === 'number' && bestMountpoint.totalBytes > 0
                ? bestMountpoint.totalBytes
                : null

            const sizeBytes = typeof d.size === 'number' && d.size > 0 ? d.size : totalBytes

            const statuses = mountpoints.map((m) => m?.status).filter(Boolean)
            const hasNoMedia = statuses.includes('no-media')
            const hasUnavailable = statuses.includes('unavailable')

            const sizeText = sizeBytes
              ? `${(sizeBytes / (1024 ** 3)).toFixed(1)} GB`
              : hasNoMedia
                ? 'No media'
                : hasUnavailable
                  ? 'Unavailable'
                  : '-'
            return (
              <div className="tableRow" key={`${d.device}-${mps}`.trim()}>
                <div className="cell strong">{d.description || '-'}</div>
                <div className="cell mono">{d.device || '-'}</div>
                <div className="cell mono">{mps || '-'}</div>
                <div className="cell">{flags || '-'}</div>
                <div className="cell">{sizeText}</div>
              </div>
            )
          })}

          {droneDrives.length === 0 && !driveError && <div className="emptyState">Waiting for device…</div>}
        </div>

        <div className="table" style={{ marginTop: 12 }}>
          <div className="tableHead">
            <div>FTP</div>
            <div>Host</div>
            <div>Dir</div>
            <div>Status</div>
            <div>Items</div>
          </div>
          <div className="tableRow">
            <div className="cell strong">Directory Listing</div>
            <div className="cell mono">{ftpHost}:{ftpPort}</div>
            <div className="cell mono">{ftpDir}</div>
            <div className="cell">{ftpError ? ftpError : ftpLastUpdated ? 'Connected' : '-'}</div>
            <div className="cell">{ftpEntries.length}</div>
          </div>
          <div className="tableRow">
            <div className="cell strong">
              <div>Actions</div>
              <button
                className="smallBtn"
                style={{ marginTop: 6 }}
                onClick={() => {
                  if (ftpOpsLocked) return
                  if (ftpDir === '/' || ftpDir === parentFtpDir) return
                  setFtpDir(parentFtpDir)
                  refreshFtp(parentFtpDir)
                }}
                disabled={ftpOpsLocked || ftpDir === '/' || ftpDir === parentFtpDir}
              >
                Back
              </button>
            </div>
            <div className="cell actionsCell">
              <div className="actionsBar">
                <button className="smallBtn" onClick={() => refreshFtp(ftpDir)} disabled={ftpOpsLocked}>Refresh FTP</button>
                <button className="smallBtn" onClick={chooseFolder}>Choose Save Folder</button>
                <button
                  className="smallBtn"
                  onClick={() => startDownloadFolder(ftpDir)}
                  disabled={ftpOpsLocked}
                >
                  Download All
                </button>
              </div>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                {downloadFolder
                  ? `Save folder selected: ${String(downloadFolder).split(/[/\\]/).filter(Boolean).slice(-1)[0]}`
                  : 'Save to: default Downloads folder'}
              </div>
            </div>
          </div>
        </div>{/* end FTP table */}

        {/* ── File list ── */}
        {ftpEntries.length > 0 && (
          <table style={{ marginTop: 8, width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #eeeeee', borderRadius: 12, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 30 }} />
              <col />{/* auto - takes remaining space */}
              <col style={{ width: 96 }} />
            </colgroup>
            <tbody>
            {(ftpEntries || []).map((e, idx) => {
              const name = e?.name || ''
              const isDir = e?.type === 'dir'
              const remoteEntryPath = joinFtpPath(ftpDir, name)
              const size = typeof e?.size === 'number' ? e.size : null
              const key = remoteEntryPath
              const isTmp = String(name).toLowerCase().endsWith('.tmp')
              const isDownloadingThis = downloads[key]?.status === 'downloading'
              const dlStatus = downloads[key]?.status
              const dlStatusText = isTmp && dlStatus !== 'done' && dlStatus !== 'error'
                ? '● Recording (.tmp)'
                : dlStatus === 'downloading'
                  ? `⬇ Downloading…${downloads[key]?.progress ? ` ${(downloads[key].progress.bytes/1024/1024).toFixed(1)} MB` : ''}`
                  : dlStatus === 'done'
                    ? `✓ Done${downloads[key]?.downloadsDir ? ` — ${String(downloads[key].downloadsDir).split(/[/\\]/).filter(Boolean).slice(-1)[0]}` : ''}`
                    : dlStatus === 'error'
                      ? `✕ ${downloads[key]?.message}`
                      : ''
              return (
                <tr key={key} style={{ borderBottom: idx < ftpEntries.length - 1 ? '1px solid #f1f1f1' : 'none' }}>
                  <td style={{ textAlign: 'center', fontSize: 15, padding: '7px 4px 7px 10px', verticalAlign: 'middle' }}>{isDir ? '📁' : '📄'}</td>
                  <td style={{ padding: '7px 4px', verticalAlign: 'middle', cursor: isDir && !ftpOpsLocked ? 'pointer' : 'default', overflow: 'hidden' }}
                    onClick={() => {
                      if (ftpOpsLocked || !isDir) return
                      const next = remoteEntryPath
                      setFtpDir(next)
                      refreshFtp(next)
                    }}>
                    <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {name}{!isDir && size != null ? <span style={{ color: '#888' }}> ({(size/1024/1024).toFixed(1)} MB)</span> : ''}
                    </div>
                    {dlStatusText && <div style={{ fontSize: 11, marginTop: 2, color: dlStatus === 'error' ? '#c0392b' : dlStatus === 'done' ? '#1a7a3c' : '#0a84ff' }}>{dlStatusText}</div>}
                  </td>
                  <td style={{ padding: '7px 10px 7px 4px', verticalAlign: 'middle', textAlign: 'right' }}>
                    {isDir ? (
                      <button
                        className="smallBtn"
                        onClick={() => startDownloadFolder(remoteEntryPath)}
                        disabled={ftpOpsLocked}
                      >
                        Download Folder
                      </button>
                    ) : (
                      <button className="smallBtn" onClick={async () => {
                        setDownloads((d) => ({ ...d, [key]: { status: 'downloading', progress: null } }))
                        try {
                          await window.api.ftpDownload(remoteEntryPath, downloadFolder || undefined)
                        } catch (err) {
                          setDownloads((d) => ({ ...d, [key]: { status: 'error', message: err?.message || String(err) } }))
                        }
                      }} disabled={ftpOpsLocked || isTmp || isDownloadingThis}>Download</button>
                    )}
                  </td>
                </tr>
              )
            })}
            </tbody>
          </table>
        )}

        {/* ── Download All progress ── */}
        <div style={{ marginTop: 8, background: '#fff', border: '1px solid #eeeeee', borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Download All — Files</div>
          <div className="dlListBox">
            {downloadAllFiles.length === 0 ? (
              <div style={{ fontSize: 12, color: '#6b6b6b' }}>(no download yet)</div>
            ) : (
              downloadAllFiles.map((f) => (
                <div key={f.path} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</div>
                  <div style={{ flexShrink: 0, marginLeft: 12, textAlign: 'right' }}>{f.status}{f.bytes ? ` — ${(f.bytes/1024/1024).toFixed(1)} MB` : ''}{f.message ? ` — ${f.message}` : ''}</div>
                </div>
              ))
            )}
          </div>
        </div>

      </main>
    </div>}

      </div>{/* appContent */}
    </div>
  )
}

export default App
