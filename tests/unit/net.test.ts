import { describe, expect, it } from 'vitest'
import { assertSafeHttpUrl, isPrivateAddress } from '../../src/utils/net.js'

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
  ])('treats %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1'])(
    'treats %s as public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false)
    },
  )

  it('handles IPv6 reserved ranges', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('::')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('ff02::1')).toBe(true)
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false)
  })

  it('fails closed on unparseable input', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true)
  })
})

describe('assertSafeHttpUrl', () => {
  it('rejects non-http protocols', async () => {
    await expect(assertSafeHttpUrl('file:///etc/passwd')).rejects.toThrowError(
      /Unsupported URL protocol/,
    )
    await expect(assertSafeHttpUrl('ftp://example.com/a.mp4')).rejects.toThrowError(
      /Unsupported URL protocol/,
    )
  })

  it('rejects malformed URLs', async () => {
    await expect(assertSafeHttpUrl('not a url')).rejects.toThrowError(/Not a valid absolute URL/)
  })

  it('rejects embedded credentials', async () => {
    await expect(assertSafeHttpUrl('https://user:pass@example.com/a.mp4')).rejects.toThrowError(
      /credentials/,
    )
  })

  it('rejects localhost and metadata hosts without DNS', async () => {
    await expect(assertSafeHttpUrl('http://localhost:8080/a.mp4')).rejects.toThrowError(/Refusing/)
    await expect(assertSafeHttpUrl('http://metadata.google.internal/x')).rejects.toThrowError(
      /Refusing/,
    )
    await expect(assertSafeHttpUrl('http://127.0.0.1/a.mp4')).rejects.toThrowError(
      /private or reserved/,
    )
    await expect(assertSafeHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrowError(
      /private or reserved/,
    )
  })

  it('allows private hosts when explicitly opted in', async () => {
    const url = await assertSafeHttpUrl('http://127.0.0.1:9000/a.mp4', { allowPrivateHosts: true })
    expect(url.hostname).toBe('127.0.0.1')
  })
})
