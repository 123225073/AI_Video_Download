'use strict'
// Isolated media transfer worker. Signed URLs arrive over private IPC, never argv or logs.
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const abort = new AbortController()
let temporary
let started = false
const send = (value) => {
  if (process.connected) {
    process.send(value)
  }
}
const validUrl = (value) => {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === 'finder.video.qq.com' || url.hostname.endsWith('.finder.video.qq.com'))
  ) {
    throw new Error('WECHAT_INVALID_MEDIA')
  }
  return url.href
}
const finish = async (value) => {
  if (temporary) {
    await fs.unlink(temporary).catch(() => undefined)
  }
  send(value)
  process.disconnect()
}
process.on('message', async (input) => {
  if (input.cancel) {
    abort.abort()
    return
  }
  if (started) {
    return
  }
  started = true
  temporary = input.temporary
  try {
    await fs.mkdir(path.dirname(temporary), { recursive: true })
    let current = validUrl(input.url)
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20 * 60_000)])
    // A previous attempt may have finished copying immediately before cancellation.
    // Reuse only a fully verified task-specific output; never overwrite existing data.
    const existing = await fs.stat(input.destination).catch((error) => {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (existing) {
      await run(
        input.ffmpeg,
        ['-v', 'error', '-xerror', '-i', input.destination, '-f', 'null', '-'],
        {
          windowsHide: true,
          timeout: 10 * 60_000,
          signal
        }
      )
      signal.throwIfAborted()
      await finish({ completed: true, size: existing.size })
      return
    }
    let response
    for (let redirect = 0; redirect < 5; redirect++) {
      response = await fetch(current, {
        signal,
        redirect: 'manual',
        headers: { Referer: 'https://channels.weixin.qq.com/' }
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        current = validUrl(new URL(response.headers.get('location') || '', current).href)
      } else {
        break
      }
    }
    if (!(response?.ok && response.body)) {
      throw new Error('WECHAT_MEDIA_UNAVAILABLE')
    }
    const expected = Number(response.headers.get('content-length') || 0)
    let total = 0
    let lastUpdate = 0
    const file = await fs.open(temporary, 'wx')
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted()
        total += chunk.byteLength
        if (total > 8 * 1024 ** 3) {
          throw new Error('WECHAT_MEDIA_TOO_LARGE')
        }
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset)
          if (!bytesWritten) {
            throw new Error('WECHAT_FILE_WRITE_FAILED')
          }
          offset += bytesWritten
        }
        if (Date.now() - lastUpdate > 300) {
          send({ progress: { total, expected, processing: false } })
          lastUpdate = Date.now()
        }
      }
    } finally {
      await file.close()
    }
    if (!total || (expected && expected !== total)) {
      throw new Error('WECHAT_INCOMPLETE_DOWNLOAD')
    }
    if (input.decodeKey) {
      if (!/^\d{1,20}$/.test(input.decodeKey)) {
        throw new Error('WECHAT_INVALID_MEDIA')
      }
      const decoder = require('./decrypt.cjs')
      await decoder.ready
      const mask = decoder.getDecryptionArray(input.decodeKey)
      const file = await fs.open(temporary, 'r+')
      try {
        const bytes = Buffer.alloc(Math.min(total, mask.length))
        await file.read(bytes, 0, bytes.length, 0)
        for (let index = 0; index < bytes.length; index++) {
          // biome-ignore lint/suspicious/noBitwiseOperators: Video header decoding requires byte-wise XOR.
          bytes[index] ^= mask[index]
        }
        await file.write(bytes, 0, bytes.length, 0)
      } finally {
        await file.close()
      }
    }
    send({ progress: { total, expected: total, processing: true } })
    await run(input.ffmpeg, ['-v', 'error', '-xerror', '-i', temporary, '-f', 'null', '-'], {
      windowsHide: true,
      timeout: 10 * 60_000,
      signal
    })
    signal.throwIfAborted()
    await fs.copyFile(temporary, input.destination, fs.constants.COPYFILE_EXCL)
    await finish({ completed: true, size: total })
  } catch (error) {
    const code = String(error.code || error.message || '')
    await finish({
      error: abort.signal.aborted
        ? 'CANCELLED'
        : /^[A-Z_0-9]+$/.test(code)
          ? code
          : 'WECHAT_DOWNLOAD_FAILED'
    })
  }
})
process.on('disconnect', () => {
  abort.abort()
  if (!started) {
    process.exit(0)
  }
})
