import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  listDrives: () => ipcRenderer.invoke('drives:list'),
  readDir: (dirPath) => ipcRenderer.invoke('fs:readdir', dirPath),
  ftpList: (dir = '/', host = null) => ipcRenderer.invoke('ftp:list', { dir, host }),
  ftpGet: (remotePath, downloadsDir = null) => ipcRenderer.invoke('ftp:get', { remotePath, downloadsDir }),
  ftpDownload: (remotePath, downloadsDir = null) => ipcRenderer.invoke('ftp:download', { remotePath, downloadsDir }),
  diagPasvCheck: () => ipcRenderer.invoke('diag:pasvCheck'),
  diagFtpProbe: () => ipcRenderer.invoke('diag:ftpProbe'),
  onFtpProgress: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:progress', listener)
    return () => ipcRenderer.removeListener('ftp:progress', listener)
  },
  onFtpDone: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:done', listener)
    return () => ipcRenderer.removeListener('ftp:done', listener)
  },
  onFtpError: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:error', listener)
    return () => ipcRenderer.removeListener('ftp:error', listener)
  }
  ,
  // Download-all API + events
  ftpDownloadAll: (dir = '/', downloadsDir = null) => ipcRenderer.invoke('ftp:downloadAll', { dir, downloadsDir }),
  chooseDownloadDir: () => ipcRenderer.invoke('dialog:chooseDownloadDir'),
  onFtpDownloadAllManifest: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:downloadAll:manifest', listener)
    return () => ipcRenderer.removeListener('ftp:downloadAll:manifest', listener)
  },
  onFtpDownloadAllFileProgress: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:downloadAll:fileProgress', listener)
    return () => ipcRenderer.removeListener('ftp:downloadAll:fileProgress', listener)
  },
  onFtpDownloadAllFileStarted: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:downloadAll:fileStarted', listener)
    return () => ipcRenderer.removeListener('ftp:downloadAll:fileStarted', listener)
  },
  onFtpDownloadAllFileDone: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:downloadAll:fileDone', listener)
    return () => ipcRenderer.removeListener('ftp:downloadAll:fileDone', listener)
  },
  onFtpDownloadAllFileError: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:downloadAll:fileError', listener)
    return () => ipcRenderer.removeListener('ftp:downloadAll:fileError', listener)
  },
  onFtpDownloadAllDone: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:downloadAll:done', listener)
    return () => ipcRenderer.removeListener('ftp:downloadAll:done', listener)
  },
  onFtpDownloadAllError: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ftp:downloadAll:error', listener)
    return () => ipcRenderer.removeListener('ftp:downloadAll:error', listener)
  },
  // Decrypt .DAT file into csv/kml/tombstone
  decryptDat: (filePath, outputDir = null) => ipcRenderer.invoke('decrypt:dat', { filePath, outputDir }),
  // Open folder picker dialog (generic)
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  // Open folder picker and return all .DAT file paths inside
  chooseDatFolder: () => ipcRenderer.invoke('dialog:chooseDatFolder'),
  // Open file picker and return selected .DAT file paths
  chooseDatFiles: () => ipcRenderer.invoke('dialog:chooseDatFiles'),
  
  // Serial communication API
  serial: {
    listPorts: () => ipcRenderer.invoke('serial:listPorts'),
    connect: (portPath, options = {}) => ipcRenderer.invoke('serial:connect', { portPath, options }),
    disconnect: () => ipcRenderer.invoke('serial:disconnect'),
    send: (data) => ipcRenderer.invoke('serial:send', { data }),
    sendUrbBulk: (hexData, busNumber = 1, deviceNumber = 4, endpoint = 0x85) => ipcRenderer.invoke('serial:sendUrbBulk', { hexData, busNumber, deviceNumber, endpoint }),
    sendMultiple: (packets, delayMs = 0) => ipcRenderer.invoke('serial:sendMultiple', { packets, delayMs }),
    getStatus: () => ipcRenderer.invoke('serial:getStatus'),
    // Event listeners for serial communication
    onData: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('serial:data', listener)
      return () => ipcRenderer.removeListener('serial:data', listener)
    },
    onConnected: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('serial:connected', listener)
      return () => ipcRenderer.removeListener('serial:connected', listener)
    },
    onDisconnected: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('serial:disconnected', listener)
      return () => ipcRenderer.removeListener('serial:disconnected', listener)
    },
    onError: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('serial:error', listener)
      return () => ipcRenderer.removeListener('serial:error', listener)
    },
    onUrbBulkSent: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('serial:urbBulkSent', listener)
      return () => ipcRenderer.removeListener('serial:urbBulkSent', listener)
    },
    onUrbBulkError: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('serial:urbBulkError', listener)
      return () => ipcRenderer.removeListener('serial:urbBulkError', listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
