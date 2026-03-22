import { useState } from 'react'

const STATUS_ICON = { idle: '○', waiting: '⏳', processing: '⚙', done: '✓', error: '✗' }
const STATUS_COLOR = { idle: '#6b6b6b', waiting: '#b07d00', processing: '#0062cc', done: '#1a7a3c', error: '#c0392b' }

function formatBytes(b) {
  if (b == null) return '-'
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB'
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB'
  return b + ' B'
}

export default function DecryptDatConTab() {
  const [files, setFiles] = useState([])
  const [outputDir, setOutputDir] = useState('')
  const [processing, setProcessing] = useState(false)

  async function addDatFiles() {
    const picked = await window.api.chooseDatFiles?.()
    if (!picked || !Array.isArray(picked) || picked.length === 0) return
    addFiles(picked)
  }

  function addFiles(newPaths) {
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path))
      const toAdd = newPaths
        .filter((p) => !existing.has(p))
        .map((p) => ({
          id: p,
          path: p,
          name: p.split(/[/\\]/).pop(),
          size: null,
          status: 'idle',
          outputs: [],
          error: null,
          engine: null
        }))
      return [...prev, ...toAdd]
    })
  }

  function removeFile(id) {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  function clearAll() {
    setFiles([])
  }

  async function addFolder() {
    const picked = await window.api.chooseDatFolder?.()
    if (!picked || !Array.isArray(picked)) return
    addFiles(picked)
  }

  async function processAll() {
    const pending = files.filter((f) => f.status === 'idle' || f.status === 'error')
    if (!pending.length) return
    setProcessing(true)

    for (const f of pending) {
      setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, status: 'processing', outputs: [], error: null } : x)))
      try {
        const result = await window.api.decryptDatCon(f.path, outputDir || null)
        setFiles((prev) => prev.map((x) => (x.id === f.id
          ? {
              ...x,
              status: 'done',
              outputs: Array.isArray(result?.outputs) ? result.outputs : [],
              size: result?.inputSize ?? x.size,
              engine: result?.engine || 'src_datcon'
            }
          : x)))
      } catch (err) {
        setFiles((prev) => prev.map((x) => (x.id === f.id
          ? {
              ...x,
              status: 'error',
              error: err?.message || String(err)
            }
          : x)))
      }
    }
    setProcessing(false)
  }

  const hasPending = files.some((f) => f.status === 'idle' || f.status === 'error')
  const doneCount = files.filter((f) => f.status === 'done').length

  return (
    <div className="decryptShell">
      <div className="decryptToolbar">
        <div className="decryptToolbarLeft">
          <button className="smallBtn primaryBtn" onClick={addDatFiles} disabled={processing}>
            + Add .DAT Files
          </button>
          <button className="smallBtn" onClick={addFolder} disabled={processing}>
            Add Folder
          </button>
          {files.length > 0 && (
            <button className="smallBtn" onClick={clearAll} disabled={processing}>
              Clear All
            </button>
          )}
        </div>
        <div className="decryptToolbarRight">
          <div className="outDirLabel">
            {outputDir
              ? <span>Engine: DatCon (src_datcon) • {outputDir.split(/[/\\]/).filter(Boolean).slice(-1)[0]}</span>
              : <span style={{ color: '#6b6b6b' }}>Engine: DatCon (src_datcon) • Output: same folder as .DAT</span>}
          </div>
          <button
            className="smallBtn"
            onClick={async () => {
              const dir = await window.api.chooseFolder?.()
              if (dir) setOutputDir(dir)
            }}
            disabled={processing}
          >
            Output Folder
          </button>
          <button className="smallBtn primaryBtn" onClick={processAll} disabled={!hasPending || processing}>
            {processing ? 'Processing…' : `Process ${files.filter((f) => f.status === 'idle' || f.status === 'error').length || ''}`}
          </button>
        </div>
      </div>

      {files.length > 0 && (
        <div className="decryptSummary">
          <span>{files.length} file{files.length > 1 ? 's' : ''}</span>
          {doneCount > 0 && <span className="summaryDone">✓ {doneCount} done</span>}
          {files.filter((f) => f.status === 'error').length > 0 && (
            <span className="summaryErr">✗ {files.filter((f) => f.status === 'error').length} error</span>
          )}
        </div>
      )}

      <div className="decryptList">
        {files.length === 0 ? (
          <div className="decryptEmpty">
            <div className="decryptEmptyIcon">🧩</div>
            <div className="decryptEmptyTitle">DatCon-style decrypt tab</div>
            <div className="decryptEmptyHint">This tab uses the src_datcon decrypt behavior (tick-based payload XOR).</div>
            <div className="decryptEmptyHint" style={{ marginTop: 4 }}>
              Each .DAT will generate: <code>.csv</code> · <code>.kml</code> · <code>-tombstone.txt</code>
            </div>
          </div>
        ) : (
          files.map((f) => (
            <div key={f.id} className={`decryptRow ${f.status}`}>
              <div className="decryptRowIcon" style={{ color: STATUS_COLOR[f.status] }}>
                {f.status === 'processing' ? <span className="spinIcon">⚙</span> : STATUS_ICON[f.status]}
              </div>

              <div className="decryptRowInfo">
                <div className="decryptRowName">{f.name}</div>
                <div className="decryptRowPath">{f.path}</div>
                {f.status === 'error' && <div className="decryptRowError">{f.error}</div>}
                {f.status === 'done' && f.outputs.length > 0 && (
                  <div className="decryptOutputList">
                    {f.outputs.map((o) => (
                      <div key={o.path} className="decryptOutput">
                        <span className="decryptOutputType">{o.type}</span>
                        <span className="decryptOutputName">{o.name}</span>
                        {o.size != null && <span className="decryptOutputSize">{formatBytes(o.size)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="decryptRowRight">
                {f.engine && <div className="decryptOutputType">{f.engine}</div>}
                {f.size != null && <div className="decryptRowSize">{formatBytes(f.size)}</div>}
                <button
                  className="iconBtn"
                  onClick={() => removeFile(f.id)}
                  disabled={f.status === 'processing'}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
