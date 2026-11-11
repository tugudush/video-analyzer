import { describe, expect, it } from 'vitest'
import {
  isAudioMimeType,
  isMediaMimeType,
  isVideoMimeType,
  mimeTypeFromPath,
} from '../../src/utils/mime.js'

describe('mimeTypeFromPath', () => {
  it('maps common video and audio extensions', () => {
    expect(mimeTypeFromPath('clip.mp4')).toBe('video/mp4')
    expect(mimeTypeFromPath('clip.MOV')).toBe('video/quicktime')
    expect(mimeTypeFromPath('clip.webm')).toBe('video/webm')
    expect(mimeTypeFromPath('voice.m4a')).toBe('audio/mp4')
    expect(mimeTypeFromPath('voice.mp3')).toBe('audio/mpeg')
  })

  it('maps output image extensions', () => {
    expect(mimeTypeFromPath('frame-0001.jpg')).toBe('image/jpeg')
  })

  it('returns undefined for unknown extensions', () => {
    expect(mimeTypeFromPath('notes.txt')).toBeUndefined()
    expect(mimeTypeFromPath('source.media')).toBeUndefined()
  })
})

describe('mime classification', () => {
  it('classifies media types', () => {
    expect(isVideoMimeType('video/mp4')).toBe(true)
    expect(isAudioMimeType('audio/mpeg')).toBe(true)
    expect(isMediaMimeType('video/webm')).toBe(true)
    expect(isMediaMimeType('image/jpeg')).toBe(false)
    expect(isMediaMimeType(undefined)).toBe(false)
  })
})
