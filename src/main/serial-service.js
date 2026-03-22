import { SerialPort } from 'serialport'
import { EventEmitter } from 'events'

/**
 * Serial Service for USB URB_BULK packet communication
 * Handles serial port operations and packet transmission
 */
class SerialService extends EventEmitter {
  constructor() {
    super()
    this.port = null
    this.isOpen = false
    this.isConnecting = false
    this.autoLoopTimer = null
    this.autoLoopBusy = false
    this.autoLoopStep = 0
    this.autoHeartbeatIndex = 0
    this.autoVersionIndex = 0
    this.autoLoopConfig = null
    this.autoLoopCycles = 0
  }

  /**
   * List all available serial ports
   */
  async listPorts() {
    try {
      const ports = await SerialPort.list()
      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || 'Unknown',
        serialNumber: p.serialNumber || 'Unknown',
        vendorId: p.vendorId,
        productId: p.productId,
        pnpId: p.pnpId
      }))
    } catch (error) {
      throw new Error(`Failed to list ports: ${error.message}`)
    }
  }

  /**
   * Connect to a serial port
   * @param {string} portPath - Path to the serial port (e.g., 'COM3', '/dev/ttyUSB0')
   * @param {object} options - Port options
   */
  async connect(portPath, options = {}) {
    if (this.isOpen || this.isConnecting) {
      throw new Error('Already connected or connecting')
    }

    try {
      this.isConnecting = true
      const defaultOptions = {
        baudRate: options.baudRate || 115200,
        dataBits: options.dataBits || 8,
        stopBits: options.stopBits || 1,
        parity: options.parity || 'none',
        rtscts: options.rtscts !== undefined ? options.rtscts : false,
        xon: options.xon !== undefined ? options.xon : false,
        xoff: options.xoff !== undefined ? options.xoff : false
      }

      this.port = new SerialPort({
        path: portPath,
        ...defaultOptions
      })

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Connection timeout'))
        }, 5000)

        this.port.on('open', () => {
          clearTimeout(timer)
          this.isOpen = true
          this.isConnecting = false
          this.emit('connected', { port: portPath, timestamp: Date.now() })
          resolve()
        })

        this.port.on('error', (error) => {
          clearTimeout(timer)
          this.isConnecting = false
          reject(error)
        })
      })

      // Setup data event listener
      this.port.on('data', (data) => {
        this.emit('data', { 
          data: Array.from(data),
          hex: data.toString('hex'),
          timestamp: Date.now()
        })
      })

      this.port.on('error', (error) => {
        this.emit('error', { 
          message: error.message,
          code: error.code,
          timestamp: Date.now()
        })
      })

      this.port.on('close', () => {
        this.stopAutoLoop()
        this.isOpen = false
        this.emit('disconnected', { timestamp: Date.now() })
      })

    } catch (error) {
      this.isConnecting = false
      throw new Error(`Failed to connect to ${portPath}: ${error.message}`)
    }
  }

  /**
   * Disconnect from serial port
   */
  async disconnect() {
    if (!this.port || !this.isOpen) {
      throw new Error('Not connected to any port')
    }

    this.stopAutoLoop()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Disconnect timeout'))
      }, 5000)

      this.port.close((error) => {
        clearTimeout(timer)
        if (error) {
          reject(error)
        } else {
          this.port = null
          this.isOpen = false
          resolve()
        }
      })
    })
  }

  /**
   * Send raw data/packet over serial port
   * @param {Buffer|Uint8Array|string|Array<number>} data - Data to send
   * @returns {Promise<object>} Result with bytes sent info
   */
  async send(data) {
    if (!this.port || !this.isOpen) {
      throw new Error('Serial port is not open')
    }

    try {
      // Convert various input formats to Buffer
      let buffer
      if (typeof data === 'string') {
        // Treat as hex string (e.g., "1b00a009...")
        const cleanHex = data.replace(/\s/g, '')
        if (!/^[0-9a-fA-F]*$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
          throw new Error('Invalid hex string format')
        }
        buffer = Buffer.from(cleanHex, 'hex')
      } else if (Array.isArray(data)) {
        // Array of bytes
        buffer = Buffer.from(data)
      } else if (data instanceof Uint8Array) {
        buffer = Buffer.from(data)
      } else if (Buffer.isBuffer(data)) {
        buffer = data
      } else {
        throw new Error('Invalid data format')
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Send timeout'))
        }, 5000)

        this.port.write(buffer, (error) => {
          clearTimeout(timer)
          if (error) {
            reject(new Error(`Failed to write data: ${error.message}`))
          } else {
            resolve({
              bytesSent: buffer.length,
              data: Array.from(buffer),
              hex: buffer.toString('hex'),
              timestamp: Date.now()
            })
          }
        })
      })
    } catch (error) {
      throw new Error(`Send failed: ${error.message}`)
    }
  }

  /**
   * Send URB_BULK packet (USB Request Block BULK transfer)
   * @param {string|Array<number>|Buffer} hexData - Hex data to send
   * @param {number|string} busNumber - USB bus number (default: 1)
   * @param {number|string} deviceNumber - USB device number (default: 4)
   * @param {number|string} endpoint - USB endpoint address (default: 0x85)
   * @returns {Promise<object>} Send result with URB info
   */
  async sendUrbBulk(hexData, busNumber = 1, deviceNumber = 4, endpoint = 0x85) {
    if (!this.port || !this.isOpen) {
      throw new Error('Serial port is not open')
    }

    try {
      // Convert hex data to buffer
      let buffer
      if (typeof hexData === 'string') {
        const cleanHex = hexData.replace(/\s/g, '')
        if (!/^[0-9a-fA-F]*$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
          throw new Error('Invalid hex data format')
        }
        buffer = Buffer.from(cleanHex, 'hex')
      } else if (Array.isArray(hexData)) {
        buffer = Buffer.from(hexData)
      } else if (hexData instanceof Uint8Array) {
        buffer = Buffer.from(hexData)
      } else if (Buffer.isBuffer(hexData)) {
        buffer = hexData
      } else {
        throw new Error('Invalid hex data format')
      }

      // Normalize values
      const bus = parseInt(busNumber).toString()
      const device = parseInt(deviceNumber).toString()

      // Normalize endpoint to hex string
      let epHex = endpoint.toString(16).toUpperCase()
      if (epHex.length === 1) epHex = '0' + epHex
      if (epHex.startsWith('0X')) epHex = epHex.substring(2)

      const fullEndpoint = `${bus}.${device}.${endpoint}`
      const fullEndpointHex = `${bus}.${device}.0x${epHex}`

      // Send the URB_BULK packet
      const result = await this.send(buffer)

      // Emit URB_BULK event
      this.emit('urb-bulk-sent', {
        ...result,
        busNumber: bus,
        deviceNumber: device,
        endpoint: `0x${epHex}`,
        endpointDec: parseInt(epHex, 16),
        fullEndpoint: fullEndpoint,
        fullEndpointHex: fullEndpointHex,
        type: 'URB_BULK',
        timestamp: Date.now()
      })

      return {
        ...result,
        busNumber: bus,
        deviceNumber: device,
        endpoint: `0x${epHex}`,
        endpointDec: parseInt(epHex, 16),
        fullEndpoint: fullEndpoint,
        fullEndpointHex: fullEndpointHex
      }
    } catch (error) {
      this.emit('urb-bulk-error', {
        message: error.message,
        busNumber: busNumber,
        deviceNumber: deviceNumber,
        endpoint: endpoint,
        timestamp: Date.now()
      })
      throw error
    }
  }

  /**
   * Send multiple packets in sequence
   * @param {Array<string|Array<number>|Buffer>} packets - Array of packets
   * @param {number} delayMs - Delay between packets in milliseconds (default: 0)
   * @returns {Promise<Array<object>>} Array of send results
   */
  async sendMultiple(packets, delayMs = 0) {
    if (!Array.isArray(packets) || packets.length === 0) {
      throw new Error('Packets must be a non-empty array')
    }

    const results = []
    for (let i = 0; i < packets.length; i++) {
      const result = await this.send(packets[i])
      results.push(result)

      if (i < packets.length - 1 && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }

    return results
  }

  /**
   * Get current connection status
   */
  getStatus() {
    return {
      isOpen: this.isOpen,
      isConnecting: this.isConnecting,
      path: this.port?.path || null,
      timestamp: Date.now()
    }
  }

  startAutoLoop(heartbeatPackets = [], versionPackets = [], intervalMs = 200) {
    if (!this.port || !this.isOpen) {
      throw new Error('Serial port is not open')
    }
    if (!Array.isArray(heartbeatPackets) || heartbeatPackets.length === 0) {
      throw new Error('heartbeatPackets must be a non-empty array')
    }
    if (!Array.isArray(versionPackets) || versionPackets.length === 0) {
      throw new Error('versionPackets must be a non-empty array')
    }

    this.stopAutoLoop()

    this.autoLoopConfig = {
      heartbeatPackets,
      versionPackets,
      intervalMs: Math.max(50, Number(intervalMs) || 200)
    }
    this.autoLoopBusy = false
    this.autoLoopStep = 0
    this.autoHeartbeatIndex = 0
    this.autoVersionIndex = 0
    this.autoLoopCycles = 0

    this.emit('auto-loop-state', {
      active: true,
      intervalMs: this.autoLoopConfig.intervalMs,
      cycles: this.autoLoopCycles,
      timestamp: Date.now()
    })

    this.autoLoopTimer = setInterval(async () => {
      if (this.autoLoopBusy || !this.isOpen || !this.autoLoopConfig) return

      this.autoLoopBusy = true
      try {
        const step = this.autoLoopStep % 8
        let hexData = ''
        let tag = ''

        if (step < 7) {
          const idx = this.autoHeartbeatIndex % this.autoLoopConfig.heartbeatPackets.length
          hexData = this.autoLoopConfig.heartbeatPackets[idx]
          this.autoHeartbeatIndex += 1
          tag = `heartbeat ${step + 1}/7`
        } else {
          const idx = this.autoVersionIndex % this.autoLoopConfig.versionPackets.length
          hexData = this.autoLoopConfig.versionPackets[idx]
          this.autoVersionIndex += 1
          tag = 'version-inquiry 1/1'
        }

        await this.sendUrbBulk(hexData)

        this.autoLoopStep += 1
        if (this.autoLoopStep % 8 === 0) {
          this.autoLoopCycles += 1
          this.emit('auto-loop-state', {
            active: true,
            intervalMs: this.autoLoopConfig.intervalMs,
            cycles: this.autoLoopCycles,
            timestamp: Date.now()
          })
        }

        this.emit('auto-loop-tick', {
          tag,
          step: this.autoLoopStep,
          cycles: this.autoLoopCycles,
          timestamp: Date.now()
        })
      } catch (error) {
        this.emit('auto-loop-error', {
          message: error?.message || String(error),
          timestamp: Date.now()
        })
      } finally {
        this.autoLoopBusy = false
      }
    }, this.autoLoopConfig.intervalMs)

    return this.getAutoLoopStatus()
  }

  stopAutoLoop() {
    if (this.autoLoopTimer) {
      clearInterval(this.autoLoopTimer)
      this.autoLoopTimer = null
    }

    const wasActive = !!this.autoLoopConfig
    this.autoLoopBusy = false
    this.autoLoopConfig = null

    if (wasActive) {
      this.emit('auto-loop-state', {
        active: false,
        intervalMs: 200,
        cycles: this.autoLoopCycles,
        timestamp: Date.now()
      })
    }

    return this.getAutoLoopStatus()
  }

  getAutoLoopStatus() {
    return {
      active: !!this.autoLoopConfig,
      intervalMs: this.autoLoopConfig?.intervalMs || 200,
      cycles: this.autoLoopCycles,
      timestamp: Date.now()
    }
  }
}

export default SerialService
