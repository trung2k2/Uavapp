import { useState, useEffect, useRef } from 'react'
import packets from '../packets.js'

const STATUS_ICON = { idle: '○', waiting: '⏳', processing: '⚙', done: '✓', error: '✗' }
const STATUS_COLOR = { idle: '#6b6b6b', waiting: '#b07d00', processing: '#0062cc', done: '#1a7a3c', error: '#c0392b' }

export default function SerialTab() {
  const [ports, setPorts] = useState([])
  const [selectedPort, setSelectedPort] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState('disconnected')

  // URB_BULK hex packet text
  const [hexData, setHexData] = useState('00001b00a00932cd09d2ffff0000000009000002001c0085030000000000')

  // Packet buffer
  const [packetBuffer, setPacketBuffer] = useState([])
  const [sendingAll, setSendingAll] = useState(false)
  const [showOnlySentPackets, setShowOnlySentPackets] = useState(true)

  const [sendStatus, setSendStatus] = useState('')
  const [lastResult, setLastResult] = useState(null)
  const [events, setEvents] = useState([])
  const [selectedMode, setSelectedMode] = useState('')

  // Auto periodic states
  const [isPeriodic, setIsPeriodic] = useState(false)
  const [periodicCount, setPeriodicCount] = useState(0)
  const [autoPatternActive, setAutoPatternActive] = useState(false)
  
  const packetListRef = useRef(null)

  useEffect(() => {
    if (packetListRef.current) {
      packetListRef.current.scrollTop = packetListRef.current.scrollHeight
    }
  }, [packetBuffer])

  useEffect(() => {
    loadPorts()

    // Listen for serial events
    const removeDataListener = window.api.serial.onData((data) => {
      if (!showOnlySentPackets) {
        addEvent('data', `Received: ${data.length} bytes`)
      }
    })

    const removeUrbBulkSentListener = window.api.serial.onUrbBulkSent((data) => {
      addEvent('urb-bulk-sent', `URB_BULK sent to ${data.fullEndpointHex}`)
      setLastResult(data)
    })

    const removeUrbBulkErrorListener = window.api.serial.onUrbBulkError((error) => {
      addEvent('urb-bulk-error', `URB_BULK error: ${error.message}`)
    })

    const removeAutoLoopStateListener = window.api.serial.onAutoLoopState((data) => {
      setAutoPatternActive(!!data?.active)
      setIsPeriodic(!!data?.active)
      if (typeof data?.cycles === 'number') {
        setPeriodicCount(data.cycles)
      }
    })

    const removeAutoLoopTickListener = window.api.serial.onAutoLoopTick((data) => {
      if (data?.tag) {
        addEvent('urb-bulk-sent', `[AUTO] ${data.tag}`)
      }
    })

    const removeAutoLoopErrorListener = window.api.serial.onAutoLoopError((error) => {
      addEvent('error', `Auto loop send error: ${error?.message || 'Unknown error'}`)
    })

    window.api.serial.getAutoLoopStatus().then((status) => {
      setAutoPatternActive(!!status?.active)
      setIsPeriodic(!!status?.active)
      if (typeof status?.cycles === 'number') {
        setPeriodicCount(status.cycles)
      }
    }).catch(() => {})

    return () => {
      removeDataListener?.()
      removeUrbBulkSentListener?.()
      removeUrbBulkErrorListener?.()
      removeAutoLoopStateListener?.()
      removeAutoLoopTickListener?.()
      removeAutoLoopErrorListener?.()
    }
  }, [showOnlySentPackets])

  function addEvent(type, message) {
    const event = {
      id: Date.now(),
      type,
      message,
      timestamp: new Date().toLocaleTimeString()
    }
    setEvents(prev => [event, ...prev.slice(0, 49)]) // Keep last 50 events
  }

  async function loadPorts() {
    try {
      const availablePorts = await window.api.serial.listPorts()
      setPorts(availablePorts || [])
    } catch (error) {
      addEvent('error', `Failed to load ports: ${error.message}`)
    }
  }

  async function connect() {
    if (!selectedPort) return

    try {
      setConnectionStatus('connecting')
      await window.api.serial.connect(selectedPort, { baudRate: 115200 })
      setIsConnected(true)
      setConnectionStatus('connected')
      addEvent('connection', `Connected to ${selectedPort}`)
    } catch (error) {
      setConnectionStatus('error')
      addEvent('error', `Connection failed: ${error.message}`)
    }
  }

  async function disconnect() {
    try {
      await stopAutoPatternLoop()
      await window.api.serial.disconnect()
      setIsConnected(false)
      setConnectionStatus('disconnected')
      addEvent('connection', 'Disconnected')
    } catch (error) {
      addEvent('error', `Disconnect failed: ${error.message}`)
    }
  }

  async function sendUrbBulk() {
    if (!isConnected) {
      setSendStatus('Not connected')
      return
    }

    try {
      setSendStatus('sending')
      const result = await window.api.serial.sendUrbBulk(hexData)
      setSendStatus('sent')
      setLastResult(result)
      addEvent('urb-bulk-sent', `Sent to ${result.fullEndpointHex || 'default endpoint'}`)
    } catch (error) {
      setSendStatus('error')
      addEvent('error', `Send failed: ${error.message}`)
    }
  }

  function clearEvents() {
    setEvents([])
  }

  function addPacket() {
    if (!hexData.trim()) {
      addEvent('error', 'Hex data cannot be empty')
      return
    }

    const packet = {
      id: Date.now(),
      hexData: hexData.trim(),
      timestamp: new Date().toLocaleTimeString()
    }

    setPacketBuffer(prev => [...prev, packet])
    addEvent('buffer', `Added packet to buffer (${packetBuffer.length + 1} total)`)
  }

  function removePacket(id) {
    setPacketBuffer(prev => prev.filter(p => p.id !== id))
    addEvent('buffer', 'Removed packet from buffer')
  }

  function clearBuffer() {
    setPacketBuffer([])
    addEvent('buffer', 'Cleared packet buffer')
  }

  async function sendAllPackets() {
    if (packetBuffer.length === 0) {
      setSendStatus('No packets in buffer')
      return
    }

    try {
      setSendingAll(true)
      setSendStatus(`Sending ${packetBuffer.length} packets...`)

      const results = []
      for (let i = 0; i < packetBuffer.length; i++) {
        const packet = packetBuffer[i]
        setSendStatus(`Sending packet ${i + 1}/${packetBuffer.length}...`)

        const result = await window.api.serial.sendUrbBulk(packet.hexData)
        results.push(result)
        addEvent('urb-bulk-sent', `Sent packet ${i + 1}/${packetBuffer.length} to ${result.fullEndpointHex || 'default endpoint'}`)

        // Add delay between packets to prevent overwhelming the device
        if (i < packetBuffer.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200)) // 200ms delay
        }
      }

      setSendStatus(`Sent ${results.length} packets successfully`)
      addEvent('buffer', `Completed sending ${results.length} packets`)
    } catch (error) {
      setSendStatus('error')
      addEvent('error', `Send all failed: ${error.message}`)
    } finally {
      setSendingAll(false)
    }
  }

  async function sendModePackets() {
    if (!selectedMode || !packets[selectedMode]) {
      setSendStatus('No mode selected or no packets defined')
      return
    }

    if (!isConnected) {
      setSendStatus('Not connected')
      return
    }

    try {
      const modePackets = packets[selectedMode]
      setSendStatus(`Sending ${modePackets.length} packets for ${selectedMode}...`)

      const results = []
      for (let i = 0; i < modePackets.length; i++) {
        const hexData = modePackets[i]
        setSendStatus(`Sending packet ${i + 1}/${modePackets.length}...`)

        const result = await window.api.serial.sendUrbBulk(hexData)
        results.push(result)
        addEvent('urb-bulk-sent', `Sent ${selectedMode} packet ${i + 1}/${modePackets.length} to ${result.fullEndpointHex || 'default endpoint'}`)

        // Add delay between packets
        if (i < modePackets.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }

      setSendStatus(`Sent ${results.length} packets for ${selectedMode} successfully`)
      addEvent('mode-sent', `Completed sending ${results.length} packets for ${selectedMode}`)

      if (selectedMode === 'get-device-info') {
        await startAutoPatternLoop()
      }
    } catch (error) {
      setSendStatus('error')
      addEvent('error', `Send mode packets failed: ${error.message}`)
    }
  }

  async function startAutoPatternLoop() {
    if (!isConnected) {
      return
    }

    const heartbeatPackets = packets['heartbeat-log-message'] || []
    const versionPackets = packets['version-inquiry'] || []

    if (!heartbeatPackets.length || !versionPackets.length) {
      addEvent('error', 'Missing heartbeat-log-message or version-inquiry packets')
      return
    }

    try {
      await window.api.serial.startAutoLoop(heartbeatPackets, versionPackets, 200)
      setPeriodicCount(0)
      addEvent('periodic', 'Auto loop started in backend: every 200ms, 7 heartbeat-log-message then 1 version-inquiry')
    } catch (error) {
      addEvent('error', `Start auto loop failed: ${error.message}`)
    }
  }

  async function stopAutoPatternLoop() {
    try {
      const status = await window.api.serial.stopAutoLoop()
      setAutoPatternActive(false)
      setIsPeriodic(false)
      if (typeof status?.cycles === 'number') {
        setPeriodicCount(status.cycles)
      }
      addEvent('periodic', `Auto loop stopped (${status?.cycles ?? periodicCount} full cycles: 7 heartbeat + 1 version)`)
    } catch (error) {
      addEvent('error', `Stop auto loop failed: ${error.message}`)
    }
  }

  return (
    <div className="serial-tab">
      <div className="section">
        <h3>Serial Port Connection</h3>
        <div className="form-row">
          <select
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            disabled={isConnected}
          >
            <option value="">Select Port</option>
            {ports.map(port => (
              <option key={port.path} value={port.path}>
                {port.path} - {port.manufacturer || 'Unknown'} {port.productName || ''}
              </option>
            ))}
          </select>
          <button
            onClick={isConnected ? disconnect : connect}
            disabled={!selectedPort && !isConnected}
            className={isConnected ? 'danger' : 'primary'}
          >
            {isConnected ? 'Disconnect' : 'Connect'}
          </button>
          <button onClick={loadPorts} className="secondary">
            Refresh Ports
          </button>
        </div>
        <div className="status">
          Status: <span style={{ color: connectionStatus === 'connected' ? '#1a7a3c' : '#c0392b' }}>
            {connectionStatus}
          </span>
        </div>
      </div>

      <div className="section">
        <h3>URB_BULK Packet Sender</h3>
        <div className="form-row">
          <label>
            Hex Data:
            <textarea
              value={hexData}
              onChange={(e) => setHexData(e.target.value)}
              placeholder="Enter hex data (spaces will be removed)"
              rows={3}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
        </div>
        <div className="form-row">
          <div style={{ color: '#444', fontSize: '13px' }}>
            Sending to default endpoint (configured in backend). Không cần nhập bus/device/endpoint.
          </div>
        </div>
        <div className="form-row">
          <button
            onClick={addPacket}
            className="primary"
          >
            Add to Buffer
          </button>
          <button
            onClick={sendAllPackets}
            disabled={!isConnected || packetBuffer.length === 0 || sendingAll}
            className="primary"
          >
            {sendingAll ? 'Sending...' : `Send All (${packetBuffer.length})`}
          </button>
          <button
            onClick={clearBuffer}
            disabled={packetBuffer.length === 0}
            className="danger"
          >
            Clear Buffer
          </button>
        </div>
      </div>

      <div className="section">
        <h3>Function Packets</h3>
        <div className="form-row">
          <label>
            Chọn chế độ:
            <select
              value={selectedMode}
              onChange={(e) => setSelectedMode(e.target.value)}
            >
              <option value="">Chọn chế độ</option>
              {['get-device-info', 'change-mode'].map(mode => (
                <option key={mode} value={mode}>
                  {mode.replace('-', ' ').toUpperCase()} ({packets[mode].length} packets)
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={sendModePackets}
            disabled={!isConnected || !selectedMode}
            className="primary"
          >
            Gửi
          </button>
        </div>
        {selectedMode && packets[selectedMode] && (
          <div className="packet-preview">
            <h4>Packets for {selectedMode.replace('-', ' ').toUpperCase()}:</h4>
            <ul>
              {packets[selectedMode].map((packet, index) => (
                <li key={index}>{packet}</li>
              ))}
            </ul>
          </div>
        )}
        {isPeriodic && (
          <div style={{ marginTop: '15px', padding: '10px', backgroundColor: '#c8e6c9', borderRadius: '4px' }}>
            <span style={{ color: '#2e7d32', fontWeight: 'bold' }}>
              ✓ Đang gửi chu kỳ tự động mỗi 200ms ({periodicCount} chu kỳ đã gửi)
            </span>
          </div>
        )}
        {autoPatternActive && (
          <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#fff3cd', borderRadius: '4px' }}>
            <span style={{ color: '#856404', fontWeight: 'bold' }}>
              Auto pattern đang chạy: 7 heartbeat-log-message -&gt; 1 version-inquiry (200ms)
            </span>
          </div>
        )}
      </div>

      <div className="section">
        <h3>Packet Buffer ({packetBuffer.length} packets)</h3>
        {packetBuffer.length === 0 ? (
          <div className="no-packets">No packets in buffer. Add packets above to get started.</div>
        ) : (
          <div className="packet-list" ref={packetListRef}>
            {packetBuffer.map((packet, index) => (
              <div key={packet.id} className="packet-item">
                <div className="packet-header">
                  <span className="packet-index">#{index + 1}</span>
                  <span className="packet-time">{packet.timestamp}</span>
                  <button
                    onClick={() => removePacket(packet.id)}
                    className="remove-btn"
                    title="Remove packet"
                  >
                    ✕
                  </button>
                </div>
                <div className="packet-data">
                  {packet.hexData.length > 50 ? `${packet.hexData.substring(0, 50)}...` : packet.hexData}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <h3>Events <button onClick={clearEvents} className="secondary small">Clear</button></h3>
        <div className="form-row">
          <label>
            <input
              type="checkbox"
              checked={showOnlySentPackets}
              onChange={(e) => setShowOnlySentPackets(e.target.checked)}
            />
            Show only sent packets (hide received noise)
          </label>
        </div>
        <div className="events-list">
          {events.length === 0 ? (
            <div className="no-events">No events yet</div>
          ) : (
            events.map(event => (
              <div key={event.id} className={`event ${event.type}`}>
                <span className="timestamp">{event.timestamp}</span>
                <span className="type">{event.type}</span>
                <span className="message">{event.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <style jsx>{`
        .serial-tab {
          padding: 20px;
          max-width: 1200px;
          margin: 0 auto;
          max-height: calc(100vh - 40px);
          overflow-y: auto;
        }

        .section {
          margin-bottom: 30px;
          padding: 20px;
          border: 1px solid #ddd;
          border-radius: 8px;
          background: #f9f9f9;
        }

        .section h3 {
          margin-top: 0;
          margin-bottom: 15px;
          color: #333;
        }

        .packet-preview {
          margin-top: 15px;
          padding: 10px;
          background: #fff;
          border: 1px solid #ddd;
          border-radius: 4px;
        }

        .packet-preview h4 {
          margin-top: 0;
          margin-bottom: 10px;
          color: #333;
        }

        .packet-preview ul {
          margin: 0;
          padding-left: 20px;
        }

        .packet-preview li {
          font-family: monospace;
          font-size: 12px;
          margin-bottom: 5px;
          word-break: break-all;
        }

        .form-row label {
          display: flex;
          flex-direction: column;
          gap: 5px;
          min-width: 120px;
        }

        .form-row label input,
        .form-row label select,
        .form-row label textarea {
          padding: 8px;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 14px;
        }

        .form-row button {
          padding: 8px 16px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          min-width: 100px;
        }

        .primary { background: #007bff; color: white; }
        .secondary { background: #6c757d; color: white; }
        .danger { background: #dc3545; color: white; }
        .small { padding: 4px 8px; font-size: 12px; }

        .status {
          font-size: 14px;
          color: #666;
        }

        .result {
          margin-top: 15px;
          padding: 10px;
          background: #e9ecef;
          border-radius: 4px;
        }

        .result pre {
          margin: 0;
          font-size: 12px;
          white-space: pre-wrap;
        }

        .events-list {
          max-height: 300px;
          overflow-y: auto;
          border: 1px solid #ddd;
          border-radius: 4px;
        }

        .event {
          padding: 8px 12px;
          border-bottom: 1px solid #eee;
          display: flex;
          gap: 10px;
          align-items: center;
          font-size: 13px;
        }

        .event:last-child {
          border-bottom: none;
        }

        .event .timestamp {
          color: #666;
          font-size: 11px;
          min-width: 70px;
        }

        .event .type {
          font-weight: bold;
          text-transform: uppercase;
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 3px;
          min-width: 80px;
          text-align: center;
        }

        .event.data .type { background: #d4edda; color: #155724; }
        .event.urb-bulk-sent .type { background: #d1ecf1; color: #0c5460; }
        .event.urb-bulk-error .type { background: #f8d7da; color: #721c24; }
        .event.connection .type { background: #fff3cd; color: #856404; }
        .event.error .type { background: #f8d7da; color: #721c24; }

        .no-events {
          padding: 20px;
          text-align: center;
          color: #666;
          font-style: italic;
        }

        .no-packets {
          padding: 20px;
          text-align: center;
          color: #666;
          font-style: italic;
          background: #f8f9fa;
          border-radius: 4px;
        }

        .packet-list {
          max-height: 300px;
          overflow-y: auto;
          border: 1px solid #ddd;
          border-radius: 4px;
        }

        .packet-item {
          border-bottom: 1px solid #eee;
          padding: 12px;
        }

        .packet-item:last-child {
          border-bottom: none;
        }

        .packet-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }

        .packet-index {
          font-weight: bold;
          color: #007bff;
          min-width: 30px;
        }

        .packet-endpoint {
          font-family: monospace;
          background: #e9ecef;
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 12px;
        }

        .packet-time {
          color: #666;
          font-size: 11px;
          margin-left: auto;
        }

        .remove-btn {
          background: #dc3545;
          color: white;
          border: none;
          border-radius: 50%;
          width: 20px;
          height: 20px;
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
        }

        .remove-btn:hover {
          background: #c82333;
        }

        .packet-data {
          font-family: monospace;
          font-size: 12px;
          background: #f8f9fa;
          padding: 6px;
          border-radius: 3px;
          word-break: break-all;
          color: #495057;
        }
      `}</style>
    </div>
  )
}